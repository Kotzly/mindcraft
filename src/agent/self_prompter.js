const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.in_loop_message = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.prompt = prompt;
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        const MAX_NO_COMMAND = 3;
        while (!this.interrupt) {
            const todoState = this.agent.todo.isStuck() ? ' The same command has been tried multiple times.' : '';
            let repeat_hint = '';
            const recent = this.agent.command_history.slice(-4);
            if (recent.length >= 2) {
                const last = recent[recent.length - 1];
                const prev = recent[recent.length - 2];
                if (last.command === prev.command && last.result && prev.result &&
                    (last.result.includes('failed') || last.result.includes('Error')) &&
                    (prev.result.includes('failed') || prev.result.includes('Error'))) {
                    repeat_hint = ` The command '${last.command}' has failed twice in a row with the same result; do not repeat it, try a different command or approach.`;
                }
            }
            const msg = `You are self-prompting with the goal: '${this.prompt}'.${todoState} Respond with a command.${repeat_hint}`;

            this.in_loop_message = true;
            let used_command = await this.agent.handleMessage('system', msg, -1);
            this.in_loop_message = false;
            if (!used_command) {
                no_command_count++;
                if (no_command_count >= MAX_NO_COMMAND) {
                    let out = `Agent did not use command in the last ${MAX_NO_COMMAND} auto-prompts. Stopping auto-prompting.`;
                    this.agent.openChat(out);
                    console.warn(out);
                    this.state = STOPPED;
                    break;
                }
            }
            else {
                no_command_count = 0;
                await new Promise(r => setTimeout(r, this.cooldown));
            }
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        if (!this.loop_active) { this.interrupt = false; return; }
        // deadlock guard: if called from within the loop's own handleMessage, just set the flag
        if (this.in_loop_message) { this.interrupt = true; return; }
        this.interrupt = true;
        while (this.loop_active)
            await new Promise(r => setTimeout(r, 500));
        this.interrupt = false;
    }
    async stop(stop_action=true) {
        this.state = STOPPED;          // set first so update() cannot restart the loop meanwhile
        if (stop_action) await this.agent.actions.stop();
        await this.stopLoop();
        this.agent.todo.clear();
    }
    async pause() {
        this.state = PAUSED;
        await this.agent.actions.stop();
        await this.stopLoop();
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}