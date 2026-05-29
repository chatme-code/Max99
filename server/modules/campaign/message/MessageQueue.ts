import type { BotBase } from "../../botservice/botBase";
import type { Message } from "./Message";

/**
 * MessageQueue.ts
 *
 * Antrian pesan yang diproses secara berurutan (FIFO) untuk setiap bot game.
 * Pesan dieksekusi satu per satu — pesan berikutnya baru diproses
 * setelah dispatch pesan sebelumnya selesai (termasuk async).
 *
 * Mirrors: com.projectgoth.fusion.botservice.message.MessageQueue (Java)
 *
 * Penggunaan:
 *   const queue = new MessageQueue(bot);
 *   queue.enqueue(new GameMessage(username, text, Date.now()));
 *   queue.enqueue(new NotificationMessage(username, BotCommandEnum.JOIN));
 */
export class MessageQueue {
  private bot: BotBase;
  private messages: Message[] = [];
  private running = false;

  constructor(bot: BotBase) {
    this.bot = bot;
  }

  enqueue(message: Message): void {
    this.messages.push(message);
    if (!this.running) {
      this._processNext();
    }
  }

  private _processNext(): void {
    const message = this.messages[0];
    if (!message) {
      this.running = false;
      return;
    }

    this.running = true;

    try {
      message.dispatch(this.bot);
    } catch (e) {
      const botName =
        (this.bot as any).gameType ??
        this.bot.constructor.name;
      console.warn(
        `[MessageQueue] Exception saat dispatch pesan untuk bot "${botName}":`,
        (e as Error).message,
      );
    }

    this.messages.shift();
    setImmediate(() => this._processNext());
  }

  get size(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages = [];
    this.running  = false;
  }
}
