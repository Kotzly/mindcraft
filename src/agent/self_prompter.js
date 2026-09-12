import settings from './settings.js';

const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.in_loop_message = false; // true while the loop is inside its own handleMessage call
        this.prompt = '';
        this.planned_goal = null;
        this.idle_time = 0;
        this.cooldown = 2000;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        } else {
            this.agent.todo.clear();
            this.planned_goal = null;
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
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === STOPPED) {
            this.state = STOPPED;
            return;
        }
        // a loaded PAUSED state was waiting on a conversation that doesn't exist anymore
        // after a restart, so resume the goal loop either way. call start() with no args
        // so it reuses this.prompt/this.todo instead of treating this as a brand new goal.
        this.state = ACTIVE;
        this.start();
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

        if (settings.todo_list && this.agent.todo.items.length === 0 && this.planned_goal !== this.prompt) {
            this.planned_goal = this.prompt;
            await this.planGoal();
        }

        let no_command_count = 0;
        const MAX_NO_COMMAND = 3;
        while (!this.interrupt) {
            const msg = this.getLoopMessage();

            let used_command = false;
            this.in_loop_message = true;
            try {
                used_command = await this.agent.handleMessage('system', msg, -1);
            } catch (err) {
                // a thrown command must not take the whole agent process down with it
                console.error('Self-prompt loop error:', err);
            } finally {
                this.in_loop_message = false;
            }
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

    // kept short: it is stored in history every iteration. the guidance on how to use
    // the todo list lives in TodoList.render(), shown in the system prompt via $SELF_PROMPT.
    getLoopMessage() {
        let msg = `You are self-prompting with the goal: '${this.prompt}'.`;

        if (settings.todo_list) {
            const current = this.agent.todo.current();
            if (this.agent.todo.items.length === 0)
                msg += ` First make a plan with !setTodo("step one; step two; ...").`;
            else if (!current)
                msg += ` All todo steps are done.`;
            else
                msg += ` Current todo step ${current.number}: '${current.item.text}'.`;
        }

        msg += this.getRepeatHint();
        msg += ` Your next response MUST contain a command. Respond:`;
        return msg;
    }

    // the last two commands were identical and both failed
    getRepeatHint() {
        const recent = this.agent.command_history.slice(-2);
        if (recent.length < 2) return '';
        const [prev, last] = recent;
        const failed = entry => entry.result && /failed|error/i.test(entry.result);
        if (last.command === prev.command && failed(last) && failed(prev))
            return ` The command '${last.command}' has failed twice in a row with the same result; do not repeat it, try a different command or approach.`;
        return '';
    }

    async planGoal() {
        const { TodoList } = await import('./todo_list.js');

        const steps = TodoList.parseNumberedGoal(this.prompt);
        if (steps) {
            this.agent.todo.set(steps);
            return;
        }

        await this.agent.prompter.promptPlanning(this.prompt);
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
        if (!this.loop_active) {
            this.interrupt = false;
            return;
        }
        // called from inside the loop's own handleMessage (e.g. !endGoal): waiting for the
        // loop here would deadlock, so just flag it and let the loop exit on its own
        if (this.in_loop_message) {
            this.interrupt = true;
            return;
        }
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.state = STOPPED; // set first so update() cannot restart the loop meanwhile
        if (stop_action)
            await this.agent.actions.stop();
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
