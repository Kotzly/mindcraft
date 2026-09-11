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

            let used_command = await this.agent.handleMessage('system', msg, -1);
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

    getLoopMessage() {
        let msg = `You are self-prompting with the goal: '${this.prompt}'.`;

        if (settings.todo_list && this.agent.todo.items.length > 0) {
            const current = this.agent.todo.current();
            if (!current) {
                msg += ` All todo steps are done. If the goal is fully met use !endGoal. If it is ongoing or not met, add the next steps with !setTodo.`;
            } else if (this.agent.todo.isStuck()) {
                msg += ` Your current todo step is ${current.number}: '${current.item.text}'. It has taken ${this.agent.todo.attempts} commands. Try a different approach, split it with !setTodo, or ask for help.`;
            } else if (this.agent.todo.attempts === 0) {
                msg += ` Your current todo step is ${current.number}: '${current.item.text}'.`;
            } else {
                msg += ` Your current todo step is ${current.number}: '${current.item.text}'. If the results above show it is finished, use !doneTodo(${current.number}), otherwise keep working on it.`;
            }
        } else if (settings.todo_list && this.agent.todo.items.length === 0) {
            msg += ` First make a plan with !setTodo("step one; step two; ...").`;
        }

        msg += ` Your next response MUST contain a command with this syntax: !commandName. Respond:`;
        return msg;
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
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        this.stopLoop();
        this.state = STOPPED;
        this.agent.todo.clear();
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        this.stopLoop();
        this.state = PAUSED;
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