# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agungtriyonode/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agungtriyonode/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, in four formats: a unified
diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor
tool calls as JSON. Every file is changed or nothing is.

Built for the make.fun bounty **"Build mend, one patch tool for every AI edit format"**
(`hidden-spec-cli-01-run-20261122`, $100, closes 24 November 2026 21:00 WIB). `SPEC.md` is the
whole specification. Node 22, standard library alone:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`main.ts` is the CLI. `runner.ts` is the kit's trial runner (kept as it is): when
`MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it. `check.ts` runs the public
practice set (`program/generator/practice.json` in the kit) against `main.ts`:

    node check.ts <practice.json>

Practice score of this entry: **100/100 (1000)**.

## License

MIT — see `LICENSE`.
