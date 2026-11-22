import assert from "node:assert/strict";
import { errorDetails } from "../diag.js";

const message = "PRIVATE_USERNAME at /home/private-user/secret.txt";
const error = new Error(message);
error.stack = `Error: ${message}
    at CloudGramApi.saveTree (file:///opt/x/app.js:500:3)
    at async CloudGramApi.saveTree (file:///opt/x/app.js:512:9)
    at new Foo (file:///opt/x/x.js:1:2)
    at file:///opt/x/app.js:3:4
    at Object.<anonymous> (file:///opt/x/app.js:5:6)
    at X.method [as alias] (file:///opt/x/app.js:7:8)
${"    at async Extra.work (file:///opt/x/app.js:9:10)\n".repeat(20)}`;
const result = errorDetails(error);
assert.deepEqual(result.stack.slice(0, 6), [
    "CloudGramApi.saveTree:500:3",
    "CloudGramApi.saveTree:512:9",
    "Foo:1:2",
    "anonymous:3:4",
    "Object.<anonymous>:5:6",
    "X.method:7:8",
]);
assert.equal(result.stack.length, 12);
assert(!JSON.stringify(result).includes(message));
assert(!JSON.stringify(result).includes("PRIVATE_USERNAME"));
assert(!JSON.stringify(result).includes("/home/private-user/secret.txt"));
assert(!JSON.stringify(result).includes("/opt/x/"));
const multiline = new Error(
    "secret-user\n    at Hidden.message (file:///secret:1:2)",
);
assert(!JSON.stringify(errorDetails(multiline)).includes("Hidden.message"));
console.log("diagnostic error tests passed");
