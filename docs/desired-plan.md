# Desired architecture
📦 eVoting-System
├── 📂 backend-api
│   ├── 📂 src
│   │   ├── 📂 config
│   │   │   ├── db.ts
│   │   │   ├── env.ts
│   │   │   ├── blockchain.ts
│   │   │   └── jwt.ts
│   │   │
│   │   ├── 📂 controllers
│   │   │   ├── auth.controller.ts
│   │   │   ├── voter.controller.ts
│   │   │   ├── election.controller.ts
│   │   │   ├── candidate.controller.ts
│   │   │   ├── vote.controller.ts
│   │   │   ├── biometric.controller.ts
│   │   │   └── admin.controller.ts
│   │   │
│   │   ├── 📂 middleware
│   │   │   ├── auth.middleware.ts
│   │   │   ├── admin.middleware.ts
│   │   │   ├── upload.middleware.ts
│   │   │   └── error.middleware.ts
│   │   │
│   │   ├── 📂 models
│   │   │   ├── User.ts
│   │   │   ├── Election.ts
│   │   │   ├── Candidate.ts
│   │   │   ├── Vote.ts
│   │   │   ├── Wallet.ts
│   │   │   └── AuditLog.ts
│   │   │
│   │   ├── 📂 routes
│   │   │   ├── auth.routes.ts
│   │   │   ├── election.routes.ts
│   │   │   ├── candidate.routes.ts
│   │   │   ├── vote.routes.ts
│   │   │   ├── biometric.routes.ts
│   │   │   └── admin.routes.ts
│   │   │
│   │   ├── 📂 services
│   │   │   ├── wallet.service.ts
│   │   │   ├── blockchain.service.ts
│   │   │   ├── biometric.service.ts
│   │   │   ├── encryption.service.ts
│   │   │   ├── election.service.ts
│   │   │   └── email.service.ts
│   │   │
│   │   ├── 📂 utils
│   │   │   ├── crypto.ts
│   │   │   ├── response.ts
│   │   │   ├── logger.ts
│   │   │   └── validators.ts
│   │   │
│   │   ├── 📂 uploads
│   │   ├── 📂 types
│   │   ├── app.ts
│   │   └── server.ts
│   │
│   ├── .env
│   ├── package.json
│   └── tsconfig.json
│
├── 📂 frontend
│   ├── 📂 public
│   │
│   ├── 📂 src
│   │   ├── 📂 assets
│   │   ├── 📂 components
│   │   │   ├── common
│   │   │   ├── auth
│   │   │   ├── voting
│   │   │   ├── biometric
│   │   │   ├── election
│   │   │   └── admin
│   │   │
│   │   ├── 📂 pages
│   │   │   ├── Landing.tsx
│   │   │   ├── Login.tsx
│   │   │   ├── Register.tsx
│   │   │   ├── Dashboard.tsx
│   │   │   ├── VerifyIdentity.tsx
│   │   │   ├── CastVote.tsx
│   │   │   ├── Results.tsx
│   │   │   └── Admin.tsx
│   │   │
│   │   ├── 📂 hooks
│   │   ├── 📂 services
│   │   │   ├── api.ts
│   │   │   ├── auth.ts
│   │   │   ├── election.ts
│   │   │   ├── blockchain.ts
│   │   │   └── biometric.ts
│   │   │
│   │   ├── 📂 context
│   │   ├── 📂 store
│   │   ├── 📂 utils
│   │   │   ├── wallet.ts
│   │   │   ├── encryption.ts
│   │   │   └── contract.ts
│   │   │
│   │   ├── 📂 types
│   │   ├── App.tsx
│   │   └── main.tsx
│   │
│   ├── .env
│   └── package.json
│
├── 📂 smart-contract
│   ├── 📂 contracts
│   │   ├── Voting.sol
│   │   ├── ElectionFactory.sol
│   │   └── VoterRegistry.sol
│   │
│   ├── 📂 scripts
│   ├── 📂 ignition
│   ├── 📂 test
│   ├── hardhat.config.ts
│   └── package.json
│
├── 📂 docs
│   ├── System-flow.md
│   ├── API.md
│   ├── SmartContract.md
│   ├── Database.md
│   ├── ThreatModel.md
│   ├── SRS.pdf
│   └── UML
│       ├── UseCase.png
│       ├── Sequence.png
│       ├── ClassDiagram.png
│       └── ERDiagram.png
│
├── .gitignore
├── docker-compose.yml
├── README.md
└── LICENSE