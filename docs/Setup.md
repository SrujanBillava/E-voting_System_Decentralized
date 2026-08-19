# Backend setup

## TOTP Setup
1. Run this command project root folder

```sh
node backend-api/utils/speakeasy.js
```

2. scan the output qr in any Totp authenticator app and update the TOTP_SECRET in .env

## Admin Details in MongoDB

```sh
{
    name: "Elections Admin",
    email: "admin@election.in",
    organization: "Election Commission"
}
```

## Smart-contract setup
### open a new terminal
- keep this process alive

```sh
cd smart-contract

npx hardhat node
```

## Open another terminal:

```sh
cd smart-contract

npx hardhat compile

npx hardhat ignition deploy ignition/modules/Voting.ts --network localhost

npx hardhat console --network localhost
```