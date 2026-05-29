import type { BotBase } from "../../botservice/botBase";
import { Message } from "./Message";

/**
 * NotificationMessage.ts
 *
 * Memberitahu bot ketika user JOIN atau QUIT dari channel.
 * Saat di-dispatch, memanggil bot.onUserJoinChannel() atau bot.onUserLeaveChannel().
 *
 * Mirrors: com.projectgoth.fusion.botservice.message.NotificationMessage (Java)
 */
export enum BotCommandEnum {
  JOIN = "JOIN",
  QUIT = "QUIT",
}

export class NotificationMessage extends Message {
  private username: string;
  private notification: BotCommandEnum;

  constructor(username: string, notification: BotCommandEnum) {
    super();
    this.username     = username;
    this.notification = notification;
  }

  dispatch(bot: BotBase): void {
    switch (this.notification) {
      case BotCommandEnum.JOIN:
        bot.onUserJoinChannel(this.username);
        break;
      case BotCommandEnum.QUIT:
        bot.onUserLeaveChannel(this.username);
        break;
    }
  }
}
