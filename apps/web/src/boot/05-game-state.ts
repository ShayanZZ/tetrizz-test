// @ts-nocheck
import { PART_POOL_SIZE, partPool } from "../game/state";

for (let _pi = 0; _pi < PART_POOL_SIZE; _pi++)
  partPool.push({ px: 0, py: 0, vx: 0, vy: 0, life: 0, max: 1, size: 0, col: "" });
