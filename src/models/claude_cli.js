import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import path from 'path';
import { addUsage, createUsage } from '../utils/usage.js';

const MAX_MIRRORED_TURNS = 200;

// Sends requests through the local Claude Code CLI (`claude -p`), so they run on
// the subscription logged into the CLI instead of an API key.
//
// Each kind of prompt with a history (conversation, coding) keeps its own CLI
// session, keyed by the first line of its system prompt. The session id is
// generated up front: the first call creates the session with --session-id and
// later calls continue it with --resume, sending only the turns the session
// hasn't seen yet. Mindcraft re-renders the system prompt on every call (stats,
// inventory, examples), so it is passed each time with snapshots turned off.
// Prompts without turns (memory saving, bot responder) run as one-shot calls.
export class ClaudeCLI {
    static prefix = 'claude-cli';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        this.command = this.params.command || 'claude';
        this.timeout_ms = this.params.timeout_ms || 180000;
        // the CLI stores sessions per directory, so --resume needs a fixed cwd
        this.cwd = path.resolve('bots', '_claude_cli');
        mkdirSync(this.cwd, { recursive: true });
        this.sessions = {};
        // priced model: the dashboard shows its estimated cost (~$0.000) even before the first call
        this.usage = createUsage(0);
    }

    async sendRequest(turns, systemMessage) {
        turns = turns.map(turn => ({
            role: turn.role,
            content: typeof turn.content === 'string' ? turn.content.trim() : JSON.stringify(turn.content)
        }));

        if (turns.length === 0) {
            const prompt = 'Respond following the instructions in your system prompt.';
            const res = await this._run(this._args(systemMessage, ['--no-session-persistence']), prompt, 'one-shot');
            return this._result(res);
        }

        const key = systemMessage.split('\n')[0];
        const session = this.sessions[key] ??= { queue: Promise.resolve() };
        if (!session.id)
            this._resetSession(session);
        // calls on the same session must not overlap, or both would resume the same state
        const response = session.queue.then(() => this._sessionRequest(session, turns, systemMessage));
        session.queue = response.catch(() => {});
        return response;
    }

    async _sessionRequest(session, turns, systemMessage) {
        let { synced, dropped } = matchSession(session.turns, turns);
        if (synced === 0 && session.turns.length > 0) {
            // history no longer overlaps the session (cleared or reloaded), start a new one
            this._resetSession(session);
            dropped = 0;
        }
        // replies mindcraft discarded stay in the CLI transcript, but not in the mirror of it
        session.turns.splice(session.turns.length - dropped, dropped);

        let new_turns = turns.slice(synced);
        let prompt = renderTurns(new_turns);
        if (!prompt) // nothing new, mindcraft is asking again
            prompt = dropped > 0 ? 'SYSTEM: Your previous response was rejected. Respond again.' : 'SYSTEM: Continue.';

        let res = await this._run(this._sessionArgs(session, systemMessage), prompt, `session ${session.id}`);
        if (res.error?.includes('already in use')) {
            // an earlier call failed after the CLI had already created the session
            session.created = true;
            res = await this._run(this._sessionArgs(session, systemMessage), prompt, `session ${session.id}`);
        }
        else if (res.error?.includes('No conversation found')) {
            this._resetSession(session);
            new_turns = turns;
            prompt = renderTurns(turns);
            res = await this._run(this._sessionArgs(session, systemMessage), prompt, `session ${session.id}`);
        }
        if (res.error)
            return this._result(res);

        session.created = true;
        session.turns.push(...new_turns, { role: 'assistant', content: res.result.trim() });
        if (session.turns.length > MAX_MIRRORED_TURNS)
            session.turns.splice(0, session.turns.length - MAX_MIRRORED_TURNS);
        return res.result;
    }

    // active CLI session ids, keyed by the kind of prompt (conversation, coding, ...) —
    // pass one to `claude --resume <id>` in bots/_claude_cli to inspect that transcript
    getSessions() {
        return Object.entries(this.sessions)
            .filter(([, s]) => s.id)
            .map(([key, s]) => ({ key, id: s.id }));
    }

    _resetSession(session) {
        session.id = randomUUID();
        session.created = false;
        session.turns = []; // mirror of the turns the CLI session holds
    }

    _sessionArgs(session, systemMessage) {
        const session_args = session.created ? ['--resume', session.id] : ['--session-id', session.id];
        return this._args(systemMessage, session_args);
    }

    _args(systemMessage, session_args) {
        const args = [
            '-p', '--output-format', 'json',
            '--tools', '', '--safe-mode', '--strict-mcp-config', // no tools, CLAUDE.md, hooks or MCP servers
            '--system-prompt-snapshot', 'off', `--system-prompt=${systemMessage}`,
            ...session_args
        ];
        if (this.model_name)
            args.push(`--model=${this.model_name}`);
        if (this.params.effort)
            args.push(`--effort=${this.params.effort}`);
        return args;
    }

    _run(args, prompt, label) {
        console.log(`Awaiting claude-cli response... (model: ${this.model_name || 'default'}, ${label})`);
        const env = { ...process.env };
        if (this.params.thinking === false)
            env.MAX_THINKING_TOKENS = '0'; // the CLI has no --no-thinking flag, only this env var
        return new Promise(resolve => {
            const child = spawn(this.command, args, { cwd: this.cwd, env });
            let stdout = '', stderr = '', timed_out = false;
            const timer = setTimeout(() => {
                timed_out = true;
                child.kill();
            }, this.timeout_ms);
            child.stdout.on('data', chunk => stdout += chunk);
            child.stderr.on('data', chunk => stderr += chunk);
            child.on('error', err => {
                clearTimeout(timer);
                resolve({ error: err.message });
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                let data = null;
                try {
                    data = JSON.parse(stdout);
                } catch {}
                if (data?.usage) {
                    // total_cost_usd is the API list price; on a subscription it's an estimate, not a bill
                    addUsage(this, {
                        input: data.usage.input_tokens,
                        output: data.usage.output_tokens,
                        cache_read: data.usage.cache_read_input_tokens,
                        cache_write: data.usage.cache_creation_input_tokens,
                        cost_usd: data.total_cost_usd
                    });
                }
                if (data && !data.is_error && typeof data.result === 'string')
                    resolve({ result: data.result });
                else if (timed_out)
                    resolve({ error: `claude timed out after ${this.timeout_ms} ms` });
                else
                    resolve({ error: data?.result || stderr.trim() || stdout.trim() || `claude exited with ${signal || code}` });
            });
            child.stdin.on('error', () => {}); // claude may exit before reading stdin
            child.stdin.end(prompt);
        });
    }

    _result(res) {
        if (res.error) {
            console.error('claude-cli request failed:', res.error);
            return 'My brain disconnected, try again.';
        }
        return res.result;
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        return 'Vision is not supported with claude-cli.';
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by claude-cli.');
    }
}

// How many leading `turns` the session already holds, and how many replies at
// its end mindcraft dropped. Mindcraft's history is a sliding window, stores
// command replies cut after the command, and discards replies it rejects, so
// turns[0..synced) must match the session ending at `end`, with only assistant
// replies after that. The longest overlap wins, so a short repeated exchange
// ("ok") at the very end can't hide the real one.
function matchSession(session_turns, turns) {
    let best = { synced: 0, dropped: 0 };
    for (let end = session_turns.length; end > 0; end--) {
        if (end < session_turns.length && session_turns[end].role !== 'assistant')
            break;
        for (let synced = Math.min(end, turns.length); synced > best.synced; synced--) {
            const offset = end - synced;
            if (turns.slice(0, synced).every((turn, i) => sameTurn(session_turns[offset + i], turn))) {
                best = { synced, dropped: session_turns.length - end };
                break;
            }
        }
    }
    return best;
}

function sameTurn(session_turn, turn) {
    if (session_turn.role !== turn.role)
        return false;
    if (turn.role === 'assistant')
        return session_turn.content.startsWith(turn.content);
    return session_turn.content === turn.content;
}

// user turns already carry the sender's name; system turns get the label strictFormat uses
function renderTurns(turns) {
    return turns.map(turn => {
        if (turn.role === 'system')
            return `SYSTEM: ${turn.content}`;
        if (turn.role === 'assistant')
            return `Your output: ${turn.content}`;
        return turn.content;
    }).join('\n');
}
