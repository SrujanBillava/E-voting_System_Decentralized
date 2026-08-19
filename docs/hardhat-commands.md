
## initial hardhat setup

```sh
npm install --save-dev hardhat
npx hardhat
npm install --save-dev @nomicfoundation/hardhat-toolbox
nvm use 24
npx hardhat --init
npx hardhat compile
```

## Steps for local setup

### open a new terminal
- keep this process alive

```sh
npx hardhat node
```

👉 Open console in new terminal:

```sh
npx hardhat compile

npx hardhat ignition deploy ignition/modules/Voting.ts --network localhost

npx hardhat console --network localhost
```

👉 Run this in that console:

```sh
const { ethers } = await import("ethers");
const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const signer = await provider.getSigner(0);
const artifact = await hre.artifacts.readArtifact("Voting");
const contract = new ethers.Contract(
  "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  artifact.abi,
  signer
);
await contract.addCandidate("Alice", "Delhi");
await contract.addCandidate("Bob", "Delhi");
await contract.addCandidate("Charlie", "Karnataka");
```

## Important step: Add the localhost network to MetaMask

Network Name: Hardhat Localhost
RPC URL: http://127.0.0.1:8545
Chain ID: 31337
Currency Symbol: ETH
Block Explorer: (leave empty)

👉 Then click Save / Add Network


## Result
Vote Recorded Successfully
Your Receipt ID:

0x7374c696849185ee6c2f90b6edd047dc5671e6de6c55b5016a4fa072154479cd
Use this receipt to verify your vote later.


Good — now we’re getting somewhere. That `0n` you’re seeing:

```ts
console.log(count) // → 0n
```

👉 means:

* `candidateCount = 0`
* **You literally have no candidates stored on-chain**

So your frontend isn’t the problem — your contract just has **no data yet**.

---

## 🧠 Why this happened

Your contract:

```solidity
uint public candidateCount;
```

👉 starts at `0`

And you only increase it when:

```solidity
addCandidate(...)
```

If you never called `addCandidate()` → count stays `0n`

---

## ✅ How to check candidates in Hardhat console

### 1. Open console

```bash
npx hardhat console --network localhost
```

---

### 2. Get contract instance

```js
const { ethers } = await import("ethers");

const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const signer = await provider.getSigner();

// 👇 replace with YOUR deployed address
const address = "0xYOUR_CONTRACT_ADDRESS";

const artifact = await hre.artifacts.readArtifact("Voting");

const contract = new ethers.Contract(address, artifact.abi, signer);
```

---

### 3. Check candidate count

```js
await contract.candidateCount()
```

👉 You’ll get:

```js
0n
```

---

### 4. Add candidates manually

```js
await contract.addCandidate("Alice", "Delhi");
await contract.addCandidate("Bob", "Delhi");
await contract.addCandidate("Charlie", "Karnataka");
```

---

### 5. Verify again

```js
await contract.candidateCount()
```

👉 Now:

```js
3n
```

---

### 6. Fetch candidates

⚠️ IMPORTANT: Your IDs start from **1**, not 0

```js
await contract.getCandidate(1)
await contract.getCandidate(2)
await contract.getCandidate(3)
```

---

## 🚨 CRITICAL BUG IN YOUR FRONTEND

From your code :

```ts
for (let i = 0; i < Number(count); i++) {
  const c = await contract.getCandidate(i);
}
```

👉 ❌ WRONG

Your Solidity uses:

```solidity
candidates[candidateCount] = Candidate(candidateCount, ...)
```

👉 So IDs are:

```
1, 2, 3, ...
```

👉 But you're calling:

```
0, 1, 2 ❌
```

---

## ✅ FIX your loop

```ts
for (let i = 1; i <= Number(count); i++) {
  const c = await contract.getCandidate(i);
}
```

---

## ⚡ Why your UI showed nothing

* `count = 0n` → loop never runs
* Even if count > 0 → wrong indexing breaks it

---

## 🔁 One more important thing

Every time you restart:

```bash
npx hardhat node
```

👉 You lose:

* all candidates
* all votes
* contract state

So you must:

1. redeploy contract
2. re-add candidates

---

## 🚀 Pro tip (for your project)

Automate candidate creation in deployment:

Inside your Ignition module:

```ts
await contract.addCandidate("Alice", "Delhi");
await contract.addCandidate("Bob", "Delhi");
```

So you don’t manually add every time.

---

## 🎯 Summary

* `0n` = no candidates exist
* You must call `addCandidate()` first
* Your frontend loop is **wrong (0-based instead of 1-based)**

---

If you want next step, I can help you:

* auto-seed candidates during deployment
* or fix your frontend so it syncs perfectly with blockchain state
