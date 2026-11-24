# makefun-site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/wayangprint/makefun-site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/wayangprint/makefun-site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: a dependency-free static-site generator whose `run(input)` returns the exact same output tree as the reference — byte for byte — in a fraction of its CPU time. It re-implements the reference's front matter, template dialect, Markdown subset, slug rule and report from scratch, with a fused single-pass Markdown renderer, segment-scanning inline rendering, array-joined template output, and a cached ASCII fast path for slugs.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=output node main.ts
```

`main.ts` reads `cases.json` from the input directory, answers every case with `run()` from `solve.js`, and writes `answers.json` to the output directory. Node 22 or later, nothing to install.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tkv25np3&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
