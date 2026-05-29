import type { BotBase } from "../../botservice/botBase";
import { Message } from "./Message";

/**
 * ResponseMessage.ts
 *
 * Membawa respons yang akan dikirim bot ke channel atau ke user tertentu.
 * Mendukung:
 *  - Broadcast ke semua user di channel      → new ResponseMessage(text)
 *  - Kirim ke satu user                      → new ResponseMessage(username, text)
 *  - Kirim ke beberapa user                  → new ResponseMessage([u1, u2], text)
 *  - Semua varian di atas + flag displayPopUp
 *
 * Mirrors: com.projectgoth.fusion.botservice.message.ResponseMessage (Java)
 */
export class ResponseMessage extends Message {
  private usernames: string[] | null;
  private message: string;
  private displayPopUp: boolean;

  constructor(message: string);
  constructor(message: string, displayPopUp: boolean);
  constructor(username: string, message: string);
  constructor(username: string, message: string, displayPopUp: boolean);
  constructor(usernames: string[], message: string);
  constructor(usernames: string[], message: string, displayPopUp: boolean);
  constructor(
    first: string | string[],
    second?: string | boolean,
    third?: boolean,
  ) {
    super();

    if (Array.isArray(first)) {
      this.usernames    = first;
      this.message      = second as string;
      this.displayPopUp = third ?? false;
    } else if (typeof second === "string") {
      this.usernames    = [first];
      this.message      = second;
      this.displayPopUp = third ?? false;
    } else {
      this.usernames    = null;
      this.message      = first;
      this.displayPopUp = (second as boolean) ?? false;
    }
  }

  dispatch(bot: BotBase): void {
    try {
      if (this.usernames === null) {
        (bot as any).sendChannelMessage(this.message);
      } else {
        for (const username of this.usernames) {
          (bot as any).sendMessage(this.message, username);
        }
      }
    } catch (e) {
      console.warn(
        `[ResponseMessage] Gagal dispatch ke proxy bot: ${(e as Error).message}`,
      );
    }
  }
}
