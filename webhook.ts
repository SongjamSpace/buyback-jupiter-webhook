import express from "express";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import dotenv from "dotenv";
import path from "path";

// Load environment variables from the root .env file
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const app = express();
app.use(express.json());

// Solana native mint (SOL)
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Token to buy (BONED)
const TOKEN_MINT = new PublicKey("4mVbX7EZonRcEfiyFbbw2ByrYc7xAkUMp3NKWhDwpump");

// Jupiter API endpoint
const JUPITER_API_URL = "https://lite-api.jup.ag/swap/v1";

// Amount to reserve for transaction fees and rent (in SOL)
const FEE_RESERVE_SOL = 0.01; 

// Get quote from Jupiter
async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 200 // 2% slippage for safety
) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: slippageBps.toString(),
  });

  const response = await fetch(`${JUPITER_API_URL}/quote?${params}`, {
    headers: {
      "x-api-key": process.env.JUPITER_API_KEY || "",
    },
  });
  if (!response.ok) {
    throw new Error(`Jupiter quote failed: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

// Get swap transaction from Jupiter
async function getJupiterSwapTransaction(
  quoteResponse: any,
  userPublicKey: string,
  wrapUnwrapSOL: boolean = true
) {
  const response = await fetch(`${JUPITER_API_URL}/swap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.JUPITER_API_KEY || "",
    },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: wrapUnwrapSOL,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jupiter swap transaction failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  return await response.json();
}

/**
 * Main execution function to buy tokens
 */
async function executeBuy() {
  const privateKeyString = process.env.CREATOR_WALLET_PRIVATE_KEY;

  if (!privateKeyString) {
    throw new Error("CREATOR_WALLET_PRIVATE_KEY is not set in .env");
  }

  // Decode private key
  let secretKey: Uint8Array;
  try {
    secretKey = Uint8Array.from(JSON.parse(privateKeyString));
  } catch (e) {
    throw new Error("Error parsing private key. Ensure it is a JSON array of numbers.");
  }

  const payer = Keypair.fromSecretKey(secretKey);
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", 
    "confirmed"
  );

  console.log(`Wallet Public Key: ${payer.publicKey.toBase58()}`);
  console.log(`Target Token Mint: ${TOKEN_MINT.toBase58()}`);

  // --- Step 1: Check available SOL balance ---
  let solBalance = 0;

  try {
    solBalance = await connection.getBalance(payer.publicKey);
  } catch (error: any) {
    throw new Error(`Error checking balance: ${error.message}`);
  }

  const solBalanceSol = solBalance / LAMPORTS_PER_SOL;
  console.log(`\nSOL Balance: ${solBalanceSol.toFixed(6)} SOL`);

  if (solBalanceSol <= FEE_RESERVE_SOL) {
    throw new Error(`Insufficient SOL. You need more than ${FEE_RESERVE_SOL} SOL to cover potential fees and ATA creation.`);
  }

  // --- Step 2: Buy Tokens using Jupiter ---
  console.log("\n--- Buying Target Tokens via Jupiter ---");

  // Use all SOL minus the fee reserve
  const solAmountToSpend = solBalanceSol - FEE_RESERVE_SOL;
  const solAmountToBuyLamports = Math.floor(solAmountToSpend * LAMPORTS_PER_SOL);
  
  console.log(`Reserving ${FEE_RESERVE_SOL} SOL for fees.`);
  console.log(`Using ${solAmountToSpend.toFixed(6)} SOL to buy tokens...`);

  // Get quote from Jupiter
  console.log("Fetching quote from Jupiter...");
  const quoteResponse = await getJupiterQuote(
    SOL_MINT.toBase58(),
    TOKEN_MINT.toBase58(),
    solAmountToBuyLamports,
    200 // 2% slippage default
  );

  const outAmountFloat = Number(quoteResponse.outAmount) / 1e6; // PumpFun tokens usually have 6 decimals
  console.log(`Quote received: ~${outAmountFloat.toFixed(2)} tokens for ${solAmountToSpend.toFixed(6)} SOL`);
  console.log(`Price impact: ${quoteResponse.priceImpactPct}%`);

  // Get swap transaction
  console.log("Getting swap transaction from Jupiter...");
  const swapResponse = await getJupiterSwapTransaction(quoteResponse, payer.publicKey.toBase58());

  // Deserialize and sign the transaction
  const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, "base64");
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([payer]);

  // Send transaction
  console.log("Sending swap transaction...");
  const rawTransaction = transaction.serialize();
  const txid = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
    maxRetries: 2,
  });

  // Confirm transaction
  console.log("Confirming transaction...");
  const confirmation = await connection.confirmTransaction(txid, "confirmed");

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  console.log(`\n✅ Tokens bought successfully! Transaction ID: ${txid}`);
  
  return {
    txid,
    amountSol: solAmountToSpend,
    amountTokensExpected: outAmountFloat
  };
}

// Webhook endpoint to trigger the buy
app.post("/webhook/buy-boned", async (req, res) => {
  try {
    // Optional basic authentication
    const webhookSecret = process.env.WEBHOOK_SECRET;
    const authHeader = req.headers.authorization;
    
    if (webhookSecret && authHeader !== `Bearer ${webhookSecret}`) {
      return res.status(401).json({ error: "Unauthorized. Invalid WEBHOOK_SECRET." });
    }

    console.log("Received webhook request to buy BONED...");
    
    // Execute buy logic
    const result = await executeBuy();
    
    res.status(200).json({
      success: true,
      message: "Purchase successful",
      data: result,
      solscanUrl: `https://solscan.io/tx/${result.txid}`
    });

  } catch (error: any) {
    console.error("Webhook purchase failed:", error);
    res.status(500).json({
      success: false,
      error: error.message || "An unknown error occurred"
    });
  }
});

// Simple healthcheck
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
  console.log(`Endpoint ready at POST /webhook/buy-boned`);
});
