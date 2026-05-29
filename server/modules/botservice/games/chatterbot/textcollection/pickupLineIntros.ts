import { TextCollection } from "../textCollection";

export class PickupLineIntros extends TextCollection {
  constructor() {
    super("pl_intros", "Pickup Line Intros");
    this.loadTexts([
      "USERNAME, here's a special pickup line just for you: TEXT",
      "Hey USERNAME, someone asked me to tell you this: TEXT",
      "USERNAME... TEXT",
      "Psst USERNAME, listen up: TEXT",
      "USERNAME, your pickup line has arrived: TEXT",
      "For USERNAME's eyes only: TEXT",
      "USERNAME, I was told to say this to you: TEXT",
      "Smooth operator alert for USERNAME: TEXT",
    ]);
  }
}
