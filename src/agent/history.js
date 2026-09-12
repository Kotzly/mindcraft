import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
import { snapshotAgentUsage } from '../utils/usage.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = agent.prompter.profile.max_messages ?? settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = agent.prompter.profile.summary_chunk_size ?? settings.summary_chunk_size ?? 5;
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary

        // trims run in the background one at a time, see _scheduleTrim
        this._trim_queue = Promise.resolve();
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    // rough estimate (~4 chars/token) of the live conversation window's size, since most
    // providers here don't expose a tokenizer; doesn't include the system prompt/docs.
    estimateTokens() {
        let chars = this.memory.length;
        for (const turn of this.turns) {
            chars += typeof turn.content === 'string' ? turn.content.length : JSON.stringify(turn.content).length;
        }
        return Math.round(chars / 4);
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        try {
            this.memory = await this.agent.prompter.promptMemSaving(turns);
        } catch (err) {
            console.error('Memory saving failed, keeping old memory:', err);
            return;
        }

        if (this.memory.length > 500) {
            this.memory = this.memory.slice(0, 500);
            this.memory += '...(Memory truncated to 500 chars. Compress it more next time)';
        }

        console.log("Memory updated to: ", this.memory);
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.jsonl`;
        }
        try {
            const lines = to_store.map(turn => JSON.stringify(turn)).join('\n') + '\n';
            appendFileSync(this.full_history_fp, lines, 'utf8');
        } catch (err) {
            console.error(`Error writing ${this.name}'s full history file: ${err.message}`);
        }
    }

    // synchronous: the new turn is visible to the next prompt immediately. trimming (which
    // calls the model to summarize) runs in the background, serialized so two trims never
    // splice the turns at the same time.
    add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            this._scheduleTrim();
        }
    }

    _scheduleTrim() {
        this._trim_queue = this._trim_queue
            .then(() => this._trim())
            .catch(err => console.error('History trim failed:', err));
    }

    async _trim() {
        if (this.turns.length < this.max_messages) return;
        let chunk = this.turns.splice(0, this.summary_chunk_size);
        while (this.turns.length > 0 && this.turns[0].role === 'assistant')
            chunk.push(this.turns.shift()); // remove until turns starts with system/user message

        this.agent.prompter.notifyHistoryTrimmed();
        await this.summarizeMemories(chunk);
        await this.appendFullHistory(chunk);
    }

    async save() {
        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                todo: this.agent.self_prompter.isStopped() ? null : this.agent.todo.toJSON(),
                planned_goal: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.planned_goal,
                command_history: this.agent.command_history,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender,
                usage: snapshotAgentUsage(this.agent.prompter)
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2));
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = data.turns || [];
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}
