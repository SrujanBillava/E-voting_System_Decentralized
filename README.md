# 🗳️ VoteChain — Decentralized E-Voting System

[![Ethereum](https://img.shields.io/badge/Blockchain-Ethereum-3C3C3D?style=for-the-badge&logo=ethereum&logoColor=white)](https://ethereum.org/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.28-363636?style=for-the-badge&logo=solidity&logoColor=white)](https://soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/Hardhat-3.4.4-FFF100?style=for-the-badge&logo=hardhat&logoColor=black)](https://hardhat.org/)
[![React](https://img.shields.io/badge/React-19.2.5-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-24.15-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-5.2.1-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://mongodb.com/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-v4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)

> **Status:** VoteChain V2 is under active development. The current codebase uses the V2 backend/contract architecture; some older frontend documentation (and the legacy React screens) may not yet reflect the final implementation.

> **Vote from Anywhere. Counted on Blockchain. Verified Privately.**

A next-generation, decentralized electronic voting application (DApp) combining a secure **Web2 identity and constituency plane** with an immutable **Ethereum Web3 state ledger**.

---

## 🌟 Key Features

- 🌐 **Vote From Anywhere (Constituency Decoupling)**: A citizen registered in Delhi can walk into any polling booth in Bengaluru or Mumbai. The system maps the ballot strictly to their legal home constituency.
- ⛓️ **Tamper-Proof Smart Contracts**: Ballots and vote tallies reside directly on the Ethereum Virtual Machine (EVM), eliminating centralized database alteration risks.
- 🔒 **Zero-Knowledge-Style Anonymous Receipts**: Every voter receives a unique 32-byte `keccak256` receipt hash. Voters can independently verify on-chain that their vote was counted without revealing their candidate choice.
- 🚫 **Double-Voting Prevention**: Atomic EVM state checking (`usedReceipts` mapping) prevents duplicate voting at the bytecode level.
- 📊 **Real-Time On-Chain Results**: Live leaderboards and candidate vote distributions computed directly from smart contract storage.
- 🛡️ **2FA Administrator Portal**: Election administrators authenticate with **RFC 6238 TOTP Two-Factor Authentication** (Google Authenticator / Microsoft Authenticator) and manage voter rolls via paginated CRUD endpoints.

---

## 🏗️ System Architecture

```
+-----------------------------------------------------------------------------------+
|                                  USER / CLIENT                                    |
|                         (React 19 + Vite + TailwindCSS)                           |
+----------------------------------------+------------------------------------------+
                                         |
               +-------------------------+-------------------------+
               | (HTTP/REST - Web2)                                | (JSON-RPC - Web3)
               v                                                   v
+-----------------------------+                           +-------------------------+
|    Node.js Express API      |                           |   Ethereum Blockchain   |
|   (JWT + Bcrypt + TOTP)     |                           |   (Hardhat Node:8545)   |
+--------------+--------------+                           +------------+------------+
               |                                                       |
               v (Mongoose ODM)                                        v (EVM Bytecode)
+-----------------------------+                           +-------------------------+
|      MongoDB Database       |                           |   Voting Smart Contract |
|  - Voter Rolls & Profiles   |                           |  - Candidate Vote Counts|
|  - Admin & Constituency Data|                           |  - Spent Receipt Hashes |
+-----------------------------+                           +-------------------------+
```

---

## 📦 Project Structure

```text
evoting-system/
├── backend-api/                  # Node.js + Express REST API
│   ├── controllers/              # Voter & Admin business logic
│   │   ├── admin.js              # Admin 2FA, JWT session & Voter CRUD
│   │   └── voter.js              # Voter authentication handler
│   ├── middleware/               # Auth guards (adminProtect, voterProtect)
│   ├── models/                   # Mongoose schemas (Voter, Admin)
│   ├── routes/                   # REST routing definitions
│   ├── utils/                    # JWT signers & Speakeasy 2FA generator
│   ├── db.js                     # MongoDB connection bootstrap
│   ├── seed.js                   # Demo voter database seeder
│   └── server.js                 # Server entry point (Port 5000)
│
├── frontend/                     # React 19 + Vite Web Application
│   ├── src/
│   │   ├── components/           # UI Components (Voting, Confirm, Verify, Results, Admin)
│   │   ├── context/              # AuthContext (Voter session state)
│   │   ├── hooks/                # Custom React hooks (useLogin)
│   │   ├── pages/                # Pages (Landing, Voter Login, Home, Admin Dashboard/Voters/Candidates)
│   │   ├── types/                # TypeScript interfaces (Voter)
│   │   ├── utils/                # Axios API clients & Ethers.js contract bridge
│   │   ├── App.tsx               # Root routing & layout
│   │   └── main.tsx              # Application entry point
│   ├── vite.config.ts            # Vite configuration with Tailwind plugin
│   └── package.json
│
├── smart-contract/               # Hardhat Ethereum Smart Contract Suite
│   ├── contracts/
│   │   └── Voting.sol            # Main Voting smart contract
│   ├── scripts/
│   │   └── deploy.js             # Deployment & candidate seeding script
│   ├── ignition/                 # Hardhat Ignition modules & data
│   │   ├── modules/Voting.ts     # Declarative deployment module
│   │   └── data/candidates.ts    # 18 Candidates across Bengaluru, Delhi, Mumbai
│   └── hardhat.config.ts         # Solidity compiler profiles & networks
│
├── docs/                         # Architecture, system flow, and commands documentation
└── README.md
```

---

## 🚀 Quick Start Guide

### 1. Prerequisites
- **Node.js** `>=20.0.0`
- **MongoDB** running locally on `mongodb://127.0.0.1:27017`
- **Git**

---

### 2. Smart Contract Setup & Local Blockchain Node

```bash
# Navigate to smart-contract directory
cd smart-contract

# Install dependencies
npm install

# Compile Solidity contracts
npx hardhat compile

# Start local Ethereum node (Terminal 1)
npx hardhat node
```

In a second terminal, deploy the smart contract and seed initial candidates:

```bash
cd smart-contract
node scripts/deploy.js
```
*Contract is deployed to: `0x5FbDB2315678afecb367f032d93F642f64180aa3`*

---

### 3. Backend API Setup & Database Seeding

```bash
# Navigate to backend-api directory
cd ../backend-api

# Install dependencies
npm install

# Create backend-api/.env for local development (see backend-api/.env.example)
npm run init:env

# Create an admin account (prints a TOTP QR once; there is no signup endpoint)
npm run admin:create

# Start backend server (Terminal 2)
node server.js
```

---

### 4. Frontend Web App Setup

```bash
# Navigate to frontend directory
cd ../frontend

# Install dependencies
npm install

# Create/verify frontend/.env
VITE_API_URL=http://localhost:5000/api
VITE_CONTRACT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3

# Start Vite dev server (Terminal 3)
npm run dev
```

Open [`http://localhost:5175`](http://localhost:5175) in your browser.

---

## 🔑 Credentials

There are no built-in demo credentials. Admins are created with `npm run admin:create` (password + authenticator app).
Voters are created by an admin through the admin API. The old V1 demo logins and shared secrets no longer exist.

---

## 🔒 Security Architecture

1. **Double-Voting Prevention**: Smart contract maintains `mapping(bytes32 => bool) public usedReceipts`. Submitting a duplicate receipt hash reverts the EVM transaction.
2. **Ballot Anonymity**: The smart contract stores candidate vote increments and receipt hashes, but **never** receives or stores the voter's identity (`VoterId` or email).
3. **Password Security**: Bcrypt with 10 salt rounds executed in Mongoose `pre('save')` lifecycle hooks. Password field is marked `select: false`.
4. **Dual-Token Admin Rotation**: 15-minute Access Token for API header authorization + 7-day `HttpOnly`, `SameSite: lax` Refresh Token cookie.
5. **Two-Factor Authentication**: RFC 6238 Time-Based One-Time Passwords (TOTP) via Speakeasy.

---

## 📜 License
This project is licensed under the [MIT License](LICENSE).
