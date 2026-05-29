export enum BotState {
  NO_GAME       = "NO_GAME",
  GAME_STARTING = "GAME_STARTING",
  GAME_JOINING  = "GAME_JOINING",
  PLAYING       = "PLAYING",
}

/**
 * GameType kini berupa string dinamis — tidak lagi hardcoded sebagai union type.
 * Daftar game yang valid ditentukan oleh GameRegistry (self-registration).
 * Gunakan gameRegistry.has(name) untuk validasi, gameRegistry.getNames() untuk daftar.
 */
export type GameType = string;
