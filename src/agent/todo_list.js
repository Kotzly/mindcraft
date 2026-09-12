export class TodoList {
  items = [];
  attempts = 0;

  set(texts) {
    this.items = texts.map(text => ({ text: text.trim().slice(0, 100), done: false }));
    this.attempts = 0;
  }

  add(text) {
    const current = this.current();
    const item = { text: text.trim().slice(0, 100), done: false };
    if (current) {
      this.items.splice(current.index, 0, item);
    } else {
      this.items.push(item);
    }
    this.attempts = 0;
  }

  done(n) {
    const current = this.current();
    if (!current || current.number !== n) {
      const currentText = current ? `'${current.item.text}'` : 'none';
      const currentNum = current ? current.number : 'none';
      if (current && current.number === n - 1 && this.items[n - 1]?.done) {
        return `Step ${n} is already done. The current step is ${current.number}: '${current.item.text}'.`;
      }
      return `Step ${n} is not the current step. The current step is ${currentNum}: ${currentText === 'none' ? 'none' : currentText}. Finish it first, or change the plan with !setTodo.`;
    }
    this.items[n - 1].done = true;
    this.attempts = 0;
    const next = this.current();
    if (next) {
      return `Step ${n} done. Next step is ${next.number}: '${next.item.text}'.`;
    }
    return 'All todo steps are done. If the goal is fully met use !endGoal. If it is ongoing or not met, add the next steps with !setTodo.';
  }

  clear() {
    this.items = [];
    this.attempts = 0;
  }

  current() {
    for (let i = 0; i < this.items.length; i++) {
      if (!this.items[i].done) {
        return { item: this.items[i], number: i + 1, index: i };
      }
    }
    return null;
  }

  tick() {
    this.attempts++;
  }

  isStuck() {
    return this.attempts >= 10;
  }

  render() {
    if (this.items.length === 0) return '';
    const lines = ['YOUR TODO LIST (your own plan for the goal). When a command result or your inventory shows the current step is finished, use !doneTodo(n) before starting the next step. Use !addTodo for a missing step:'];
    const current = this.current();
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const done = item.done ? 'x' : ' ';
      let marker = '';
      if (current && current.index === i) {
        if (this.isStuck()) {
          marker = ` <- current (${this.attempts} commands so far, try a different approach or re-plan with !setTodo)`;
        } else {
          marker = ` <- current (${this.attempts} commands so far)`;
        }
      }
      lines.push(`[${done}] ${i + 1}. ${item.text}${marker}`);
    }
    return lines.join('\n');
  }

  toJSON() {
    return { items: this.items, attempts: this.attempts };
  }

  load(data) {
    if (!data) return;
    this.items = data.items || [];
    this.attempts = data.attempts || 0;
  }

  static parseSteps(text) {
    return text
      .split(/[;\n]+/)
      .map(s => s.replace(/^[\d\-\[\]\s]*\.?\s*|[\[\]×xX\s]*$/g, '').trim())
      .filter(s => s.length > 0 && s.length <= 100)
      .slice(0, 12);
  }

  static parseNumberedGoal(text) {
    const matches = text.match(/(\d+)\.\s+([^\n.]+)/g);
    if (!matches || matches.length < 2) return null;
    const steps = matches.map(m => {
      const match = m.match(/\d+\.\s+(.+)/);
      return match ? match[1].trim() : '';
    });
    for (let step of steps) {
      if (step.match(/at\s+\d+\s*,\s*\d+\s*,\s*\d+/)) {
        return null;
      }
    }
    const nums = matches.map(m => parseInt(m.match(/\d+/)[0]));
    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== i + 1) return null;
    }
    return steps.filter(s => s.length > 0).slice(0, 12);
  }
}
