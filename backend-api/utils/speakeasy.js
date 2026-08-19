import speakeasy from "speakeasy";
import qrcode from "qrcode";

const secret = speakeasy.generateSecret({
  name: "E-Voting (Admin Login)",
});

console.log("Secret:", secret.base32);
console.log("Scan this URL to add to Microsoft Authenticator:");
console.log(secret.otpauth_url);

// Instead of terminal QR, open the URL in browser:
qrcode.toDataURL(secret.otpauth_url, (err, data_url) => {
  console.log("\n--- Copy this link and open in browser ---\n");
  console.log(data_url);
});