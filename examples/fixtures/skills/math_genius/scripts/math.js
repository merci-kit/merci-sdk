/** @file Math-genius skill script: multiplies two numbers from args (a, b); prints JSON {product}. @version 0.7.2 */
const args = JSON.parse(process.argv[2] || '{}');
const num1 = Number(args.a ?? 1);
const num2 = Number(args.b ?? 1);
const product = num1 * num2;
console.log(JSON.stringify({ product }));
