# Backend setup

## Admin setup

Create an admin (password + authenticator app TOTP) with `npm run admin:create` in `backend-api/`. The TOTP secret is shown once as a QR code. There is no environment TOTP secret and no default admin.

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