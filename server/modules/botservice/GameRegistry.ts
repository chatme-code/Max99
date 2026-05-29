import type { BotBase, BotContext } from "./botBase";

/**
 * GameRegistry.ts
 *
 * Singleton registry untuk semua game bot.
 * Setiap game mendaftarkan dirinya sendiri dengan memanggil gameRegistry.register()
 * di file-nya masing-masing — tidak diperlukan import eksplisit di file pusat.
 *
 * Pola: Self-Registration / Plugin Module
 *
 * Untuk menambah game baru:
 *   1. Buat class game yang extends BotBase
 *   2. Di akhir file, panggil: gameRegistry.register({ name: "mygame", ... })
 *   3. Import file game di server/modules/botservice/games/index.ts
 *   Tidak ada file lain yang perlu diubah.
 */

export type GameCategory = "gambling" | "social" | "chatterbot" | "sports" | "table";

export interface GameDescriptor {
  name: string;
  displayName: string;
  description: string;
  category: GameCategory;
  factory: (ctx: BotContext) => BotBase;
}

class GameRegistry {
  private readonly modules = new Map<string, GameDescriptor>();

  /**
   * Daftarkan game ke registry.
   * Dipanggil sebagai side-effect saat file game di-import.
   */
  register(descriptor: GameDescriptor): void {
    const key = descriptor.name.toLowerCase();
    if (this.modules.has(key)) {
      console.warn(`[GameRegistry] Game "${key}" sudah terdaftar — diabaikan`);
      return;
    }
    this.modules.set(key, descriptor);
  }

  /**
   * Ambil deskriptor game berdasarkan nama.
   */
  get(name: string): GameDescriptor | undefined {
    return this.modules.get(name.toLowerCase());
  }

  /**
   * Cek apakah game terdaftar.
   */
  has(name: string): boolean {
    return this.modules.has(name.toLowerCase());
  }

  /**
   * Kembalikan semua game yang terdaftar.
   */
  list(): GameDescriptor[] {
    return [...this.modules.values()];
  }

  /**
   * Kembalikan semua nama game yang terdaftar.
   */
  getNames(): string[] {
    return [...this.modules.keys()];
  }

  /**
   * Kembalikan game yang difilter berdasarkan kategori.
   */
  listByCategory(category: GameCategory): GameDescriptor[] {
    return this.list().filter(g => g.category === category);
  }
}

export const gameRegistry = new GameRegistry();
