import { BotContext } from "../../botBase";
import { ChatterBot } from "../chatterbot/chatterbot";
import { TextCollection } from "../chatterbot/textCollection";
import { PersonalProphecies } from "../chatterbot/textcollection/personalProphecies";
import { PersonalProphecyIntros } from "../chatterbot/textcollection/personalProphecyIntros";
import { InspirationalQuotes } from "../chatterbot/textcollection/inspirationalQuotes";
import { InspirationalQuoteIntros } from "../chatterbot/textcollection/inspirationalQuoteIntros";

const COMMAND_PERSONAL_PROPHECY    = "!w";
const COMMAND_INSPIRATIONAL_QUOTE  = "!q";

function fmt(n: number): string { return n.toFixed(2); }

export class GirlFriend extends ChatterBot {
  readonly gameType = "girlfriend";

  private premiumCommandCost:      number;
  private timeBetweenPlayNowMs:    number;
  private playNowTimer:            NodeJS.Timeout | null = null;

  private readonly textMap  = new Map<string, TextCollection>();
  private readonly introMap = new Map<string, TextCollection>();

  constructor(ctx: BotContext) {
    super(ctx);
    this.premiumCommandCost   = this.param("premiumCommandCost",         0.02);
    this.timeBetweenPlayNowMs = this.param("timeBetweenPlayNowMessages", 150_000);

    this.textMap.set(COMMAND_PERSONAL_PROPHECY,   new PersonalProphecies());
    this.textMap.set(COMMAND_INSPIRATIONAL_QUOTE,  new InspirationalQuotes());
    this.introMap.set(COMMAND_PERSONAL_PROPHECY,   new PersonalProphecyIntros());
    this.introMap.set(COMMAND_INSPIRATIONAL_QUOTE,  new InspirationalQuoteIntros());

    this.sendChannelMessage(
      `GirlFriend Bot is here! Talk to me. ` +
      `${COMMAND_PERSONAL_PROPHECY} for a personal prophecy, ` +
      `${COMMAND_INSPIRATIONAL_QUOTE} for an inspirational quote — only ${fmt(this.premiumCommandCost)} credits each!`
    );

    this.playNowTimer = setInterval(() => {
      const now = Date.now();
      if (
        now - this.timeLastUserJoined      < this.timeBetweenPlayNowMs ||
        now - this.timeLastMessageReceived < this.timeBetweenPlayNowMs
      ) return;
      this.sendChannelMessage(
        `Try ${COMMAND_PERSONAL_PROPHECY} for a personal prophecy or ` +
        `${COMMAND_INSPIRATIONAL_QUOTE} for an inspirational quote! ` +
        `Only ${fmt(this.premiumCommandCost)} credits.`
      );
    }, this.timeBetweenPlayNowMs);
  }

  onUserJoinChannel(username: string): void {
    super.onUserJoinChannel(username);
    this.sendMessage(
      `Hey ${username}! I'm GirlFriend Bot. ` +
      `Try ${COMMAND_PERSONAL_PROPHECY} for a personal prophecy or ` +
      `${COMMAND_INSPIRATIONAL_QUOTE} for an inspirational quote!`,
      username
    );
  }

  stopBot(): void {
    super.stopBot();
    if (this.playNowTimer) {
      clearInterval(this.playNowTimer);
      this.playNowTimer = null;
    }
  }

  async onMessage(username: string, text: string, ts: number): Promise<void> {
    const tc    = this.textMap.get(text);
    const intro = this.introMap.get(text);

    if (!tc || !intro) {
      super.onMessage(username, text, ts);
      return;
    }

    if (!(await this.userCanAfford(username, this.premiumCommandCost))) return;

    const textItem  = tc.getNextText();
    const introItem = intro.getNextText();

    const message = introItem.content
      .replace("USERNAME", username)
      .replace("TEXT", textItem.content);

    this.sendChannelMessage(message);
    await this.chargeUser(username, this.premiumCommandCost).catch(() => {});
    this.timeLastMessageReceived = Date.now();
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "girlfriend",
  displayName: "Girlfriend Bot",
  description: "Bot pacar virtual — ngobrol romantis dan menyenangkan.",
  category: "chatterbot",
  factory: ctx => new GirlFriend(ctx),
});
