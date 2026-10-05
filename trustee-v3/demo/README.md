# demo/

Scratch directory for `npm run demo -- --store demo`. The demo writes one **encrypted** share file per trustee into its own
folder (`demo/trustee-1/`, `demo/trustee-2/`, `demo/trustee-3/`), so no single file or folder ever holds more than one trustee's share.
Everything in here except this file is git-ignored and must never be committed.
