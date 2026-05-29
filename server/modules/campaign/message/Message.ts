import type { BotBase } from "../../botservice/botBase";

/**
 * Message.ts
 *
 * Abstract base class untuk semua jenis message yang di-dispatch ke bot game.
 * Mirrors: com.projectgoth.fusion.botservice.message.Message (Java)
 */
export abstract class Message {
  abstract dispatch(bot: BotBase): void;
}
