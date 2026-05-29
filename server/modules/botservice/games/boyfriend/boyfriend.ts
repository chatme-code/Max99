import { BotContext } from "../../botBase";
import { ChatterBot } from "../chatterbot/chatterbot";
import { TextCollection } from "../chatterbot/textCollection";
import { CornyJokes } from "../chatterbot/textcollection/cornyJokes";
import { CornyJokeIntros } from "../chatterbot/textcollection/cornyJokeIntros";
import { PickupLines } from "../chatterbot/textcollection/pickupLines";
import { PickupLineIntros } from "../chatterbot/textcollection/pickupLineIntros";

const COMMAND_CORNY_JOKES  = "!c";
const COMMAND_PICKUP_LINES = "!p";

function fmt(n: number): string { return n.toFixed(2); }

export class BoyFriend extends ChatterBot {
  readonly gameType = "boyfriend";

  private premiumCommandCost:      number;
  private timeBetweenPlayNowMs:    number;
  private playNowTimer:            NodeJS.Timeout | null = null;

  private readonly textMap  = new Map<string, TextCollection>();
  private readonly introMap = new Map<string, TextCollection>();

  constructor(ctx: BotContext) {
    super(ctx);
    this.premiumCommandCost   = this.param("premiumCommandCost",          0.02);
    this.timeBetweenPlayNowMs = this.param("timeBetweenPlayNowMessages",  150_000);

    this.textMap.set(COMMAND_CORNY_JOKES,  new CornyJokes());
    this.textMap.set(COMMAND_PICKUP_LINES, new PickupLines());
    this.introMap.set(COMMAND_CORNY_JOKES,  new CornyJokeIntros());
    this.introMap.set(COMMAND_PICKUP_LINES, new PickupLineIntros());

    this.sendChannelMessage(
      `BoyFriend Bot is here! Chat with me. ` +
      `${COMMAND_PICKUP_LINES} for a pickup line, ` +
      `${COMMAND_CORNY_JOKES} for a corny joke — only ${fmt(this.premiumCommandCost)} credits each!`
    );

    this.playNowTimer = setInterval(() => {
      const now = Date.now();
      if (
        now - this.timeLastUserJoined      < this.timeBetweenPlayNowMs ||
        now - this.timeLastMessageReceived < this.timeBetweenPlayNowMs
      ) return;
      this.sendChannelMessage(
        `Try ${COMMAND_PICKUP_LINES} for a pickup line or ${COMMAND_CORNY_JOKES} for a corny joke! ` +
        `Only ${fmt(this.premiumCommandCost)} credits.`
      );
    }, this.timeBetweenPlayNowMs);
  }

  onUserJoinChannel(username: string): void {
    super.onUserJoinChannel(username);
    this.sendMessage(
      `Hey ${username}! I'm BoyFriend Bot. ` +
      `Try ${COMMAND_PICKUP_LINES} for a pickup line or ${COMMAND_CORNY_JOKES} for a corny joke!`,
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
  name: "boyfriend",
  displayName: "Boyfriend Bot",
  description: "Bot pacar virtual — ngobrol romantis dan menghibur.",
  category: "chatterbot",
  factory: ctx => new BoyFriend(ctx),
});
