import { ethers } from "ethers";
import Voting from "../../../smart-contract/artifacts/contracts/Voting.sol/Voting.json";

export const CONTRACT_ADDRESS = (import.meta.env.VITE_CONTRACT_ADDRESS as string) || "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const RPC_URL = "http://127.0.0.1:8545";

export const getReadOnlyContract = () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  return new ethers.Contract(CONTRACT_ADDRESS, Voting.abi, provider);
};

export const getContract = async () => {
  if (typeof window !== "undefined" && (window as any).ethereum) {
    try {
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      return new ethers.Contract(CONTRACT_ADDRESS, Voting.abi, signer);
    } catch (e) {
      console.warn("MetaMask connection rejected or unavailable, falling back to local signer", e);
    }
  }

  // Fallback to local hardhat node signer for smooth local development and automated testing
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const signer = await provider.getSigner(0);
    return new ethers.Contract(CONTRACT_ADDRESS, Voting.abi, signer);
  } catch (err) {
    console.error("Could not connect to Ethereum provider:", err);
    throw err;
  }
};