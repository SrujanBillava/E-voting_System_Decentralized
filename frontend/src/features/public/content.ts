/**
 * Public-facing wording, kept in one place so it can be reviewed for accuracy. Rules for everything here:
 * no "anonymous", no "zero-knowledge", no "tamper-proof", no "immune to fraud", no "cryptographically private",
 * and never "results are hidden until close". VoteChain V2 is a supervised-terminal system with a trusted operator.
 */

export const LANDING = {
  title: "Vote at a supervised polling terminal",
  lede: "VoteChain is a polling-terminal voting system. A voter signs in at a supervised terminal, receives the ballot for their own constituency, casts one vote, and gets a receipt that anyone can check against a public record.",
  steps: [
    { title: "Sign in at the terminal", text: "You identify yourself with your voter ID or email and password. A session starts on the terminal, under supervision." },
    { title: "Confirm who you are", text: "A face check at the terminal confirms the person at the screen is the registered voter." },
    { title: "Receive your constituency ballot", text: "The system works out your constituency from your voter record and shows only the candidates standing there." },
    { title: "Choose, review, confirm", text: "You select one candidate, review the selection, and confirm. After you confirm, the choice is locked for that ballot." },
    { title: "The vote is recorded", text: "The ballot is submitted to the election contract. The contract accepts it only if it carries valid authorization for that constituency and candidate, and only once per voter authorization in this election." },
    { title: "Take your receipt", text: "You get a receipt with a transaction reference. Anyone can paste it into the public verification page to confirm a ballot was recorded." },
  ],
  anchors: [
    { title: "What you can check", text: "A receipt shows that a ballot was recorded for this election and constituency, and that the record is still part of the public ledger. It does not identify the voter." },
    { title: "What stays with the operator", text: "The operator runs the terminals and the backend. VoteChain asks you to trust that operator; it does not remove that trust. The next page spells out exactly what is and is not guaranteed." },
  ],
} as const;

export const TRUST = {
  title: "What VoteChain does and does not guarantee",
  lede: "VoteChain V2 is a prototype built for supervised polling terminals. These are the properties it actually provides, and the ones it does not.",
  provides: [
    { title: "No voter personal data on the ledger", text: "The public ledger holds ballot records keyed by an election-specific reference, not names, emails, voter IDs or biometrics." },
    { title: "Contract-enforced ballot authorization", text: "The election contract only accepts a ballot for a candidate that stands in the voter's constituency, and only with a valid authorization from the election authority." },
    { title: "One accepted ballot per authorized voter", text: "Each authorized voter has an election-specific reference (a nullifier) that the contract records. The contract refuses a second ballot with the same reference." },
    { title: "Public auditability of recorded ballots", text: "Every accepted ballot is a public transaction. Anyone can verify that a given transaction is a recorded ballot of this election and where it sits in the record." },
    { title: "No wallet for voters", text: "Voters never install software, hold keys or pay fees. The terminal and the operator's service do that on their behalf." },
  ],
  limits: [
    { title: "The operator and backend are trusted", text: "The backend decides who may vote, issues the ballot authorization and submits ballots. A malicious or compromised operator could refuse or delay voters. The contract limits what it can record, but it cannot make the operator honest." },
    { title: "The chosen candidate is plaintext on the ledger", text: "Each ballot record contains the selected candidate in readable form. VoteChain does not hide it." },
    { title: "Interim totals can be derived by observers", text: "The official VoteChain application publishes results only after the election closes. Because the ledger is public and ballots are readable, an outside observer can work out running totals at any time." },
    { title: "Not zero-knowledge", text: "There is no zero-knowledge or other cryptographic privacy layer in this version." },
    { title: "Not receipt-free and not coercion-resistant", text: "A voter can show their receipt and the public ledger to someone else to prove how they voted. VoteChain does not prevent that, and it does not protect a voter from being pressured to do so." },
    { title: "No cryptographic ballot secrecy", text: "Ballot secrecy relies on supervised voting booths and on operator conduct, not on mathematics." },
    { title: "The face check is not independently trusted", text: "Face verification runs in the terminal's browser. Its liveness check cannot be independently verified by the server, so it should be treated as a convenience for supervised use, not as proof of identity on its own." },
  ],
  verifyStatement:
    "A confirmed public receipt shows that a ballot represented by that transaction was recorded by this VoteChain contract for this election and constituency, and that it remains on the public ledger. It does not show who the voter was, that the recorded choice matches what the voter intended, or that the vote was secret.",
} as const;

export const ACCESSIBILITY = {
  title: "Accessibility",
  lede: "VoteChain is designed to be usable by keyboard, touch and screen reader. A polling official can always help.",
  items: [
    { title: "Keyboard", text: "Every control can be reached and used with the keyboard. The focus indicator is always visible." },
    { title: "Touch", text: "At the terminal, controls are large and spaced for touch. Selecting a candidate uses standard radio buttons." },
    { title: "Screen readers", text: "Pages use headings, labelled form fields and live status messages. Errors are announced." },
    { title: "Colour and contrast", text: "Text meets contrast guidelines. Election status and errors are always written out in words, never shown by colour alone." },
    { title: "Time", text: "Sessions at the terminal end after a short period without activity for privacy. A countdown is shown, and an official can restart a session." },
    { title: "Getting help", text: "If you cannot use a terminal unaided, ask a polling official. The official can help you operate the terminal but must not choose for you." },
  ],
} as const;

export const PHASE_COPY = {
  Setup: { label: "Setup", text: "The election is being prepared. Voting has not opened." },
  Open: { label: "Open", text: "Voting is open at polling terminals." },
  Closed: { label: "Closed", text: "Voting has ended. Official results are available." },
} as const;
