/**
 * games/index.ts
 *
 * Titik masuk tunggal untuk registrasi semua game bot.
 * Cukup import file ini untuk mengaktifkan semua game di GameRegistry.
 *
 * Setiap import di bawah memicu side-effect gameRegistry.register(...)
 * yang ada di akhir masing-masing file game.
 *
 * Untuk menambah game baru:
 *   1. Buat folder + class game (extends BotBase)
 *   2. Tambahkan gameRegistry.register(...) di akhir file game tersebut
 *   3. Tambahkan satu baris import di sini
 *   Tidak ada file lain yang perlu diubah.
 */

// ── Gambling ────────────────────────────────────────────────────────────────
import "./dice/dice";
import "./blackjack/blackjack";
import "./baccarat/baccarat";
import "./headsOrTails/headsOrTails";
import "./rockPaperScissors/rockPaperScissors";
import "./russianRoulette/russianRoulette";
import "./knockout/knockout";
import "./icarus/icarus";
import "./lowcard/lowcard";
import "./tebakhati/tebakhati";

// ── Sports ──────────────────────────────────────────────────────────────────
import "./cricket/cricket";
import "./football/football";
import "./warriors/warriors";

// ── Social / Table ──────────────────────────────────────────────────────────
import "./trivia/trivia";
import "./vampire/vampire";
import "./esp/esp";
import "./werewolf/werewolf";
import "./questionbot/questionbot";
import "./one/one";

// ── Chatterbot ──────────────────────────────────────────────────────────────
import "./chatterbot/chatterbot";
import "./girlfriend/girlfriend";
import "./boyfriend/boyfriend";
