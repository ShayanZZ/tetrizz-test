// @ts-nocheck
import { setBotContext } from "@tetrizz/bot";
import { clock } from "../core/clock";
import { gameRandom } from "../core/random";
import { botControlState } from "../bot/bot-control";

botControlState._frameGap = 16.7;
botControlState._frameWork = 6;
botControlState._lastFrameTs = clock.now();

setBotContext({ random: gameRandom });
