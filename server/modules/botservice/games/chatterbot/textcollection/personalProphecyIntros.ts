import { TextCollection } from "../textCollection";

export class PersonalProphecyIntros extends TextCollection {
  constructor() {
    super("pp_intros", "Personal Prophecy Intros");
    this.loadTexts([
      "USERNAME, the stars have spoken your personal prophecy: TEXT",
      "I sense a vision for you USERNAME... TEXT",
      "USERNAME, gaze into the crystal ball: TEXT",
      "The universe whispers to you USERNAME: TEXT",
      "USERNAME, your destiny reveals itself: TEXT",
      "My inner eye sees this for you USERNAME: TEXT",
      "USERNAME, here is your personal prophecy: TEXT",
      "The mystical forces have a message for you USERNAME: TEXT",
    ]);
  }
}
