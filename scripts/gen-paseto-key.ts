import { generateKeys } from "paseto-ts/v4";

const localKey = generateKeys("local");
// localKey: k4.local.xxx..

console.log(`PASETO_KEY=${localKey}`);
