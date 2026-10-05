// Everything the final ceremony and the artifact provisioning TRUST from outside this repository's own files, pinned in one place.
// The values come from privacy-v3/results/build-info.json as it was before the ceremony (the frozen milestone's build record).
export const PINS = Object.freeze({
  circomVersion: "circom compiler 2.2.3",
  snarkjsVersion: "0.7.5",
  circuitSourceSha256: "885eb08c06439a41c608c403a3857c75ddf21cf1aa885b3414201921660c844c",
  r1csSha256: "8cf62bd036a2d7c240d98d599eccbfb3f63ee2789fb0d07e13cc6effa67c047a",
  wasmSha256: "15c7ce50f6efc22759c24e399bf8ed6f16adef881930da466542608e7f51d3df",
  ptau: Object.freeze({
    file: "ppot_0080_18.ptau",
    sha256: "9693220206afab749e3d88d4ab5fdf5d36120ea102e7e587ccea0e7a5208e711",
    power: 18,
    source: "https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_18.ptau",
  }),
  // the development TEST setup that this ceremony replaces: a final zkey / key equal to either is refused
  previousTestZkeySha256: "8be58c6d8b445ce91167bb7c9f117b1dee5107a6b0de71be5eb49be1017d2816",
  previousTestVerificationKeySha256: "6bd3195a26aa7aa1e78e629d9f8d05cb5e4fbf8148500d5d22a4f60c5afad61d",
});
