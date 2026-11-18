// @ts-nocheck
import { PIECES } from "@tetrizz/core";
import { shade, themeState } from "../render/theme";

themeState.COL = PIECES.map((p) => ({ base: p.c, hi: shade(p.c, 0.42), lo: shade(p.c, -0.34) }));

themeState.COL.push({ base: "#707a88", hi: shade("#707a88", 0.42), lo: shade("#707a88", -0.34) });
