import type { BotBase } from "../../botservice/botBase";
import { Message } from "./Message";

/**
 * GameMessage.ts
 *
 * Membawa pesan dari user yang dikirim ke channel bot game.
 * Saat di-dispatch, memanggil bot.onMessage() dengan username, teks, dan timestamp.
 *
 * Mirrors: com.projectgoth.fusion.botservice.message.GameMessage (Java)
 */
export class GameMessage extends Message {
  private username: string;
  private message: string;
  private receivedTimestamp: number;

  constructor(username: string, message: string, receivedTimestamp: number) {
    super();
    this.username          = username;
    this.message           = message;
    this.receivedTimestamp = receivedTimestamp;
  }

  dispatch(bot: BotBase): void {
    bot.onMessage(this.username, this.message, this.receivedTimestamp);
  }
}
