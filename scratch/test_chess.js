const { Chess } = require('chess.js');

try {
  const g = new Chess();
  console.log('Trying move e2 to e4 with promotion = undefined...');
  const move = g.move({ from: 'e2', to: 'e4', promotion: undefined });
  console.log('Result:', move);
} catch (e) {
  console.error('Caught error:', e.message);
}
