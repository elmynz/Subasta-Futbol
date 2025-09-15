// Script to update fake prices to be 25% higher than real prices
// and adjust the probability of fake prices appearing to 70%

const fs = require('fs');
const path = require('path');

// Read the HTML file
const filePath = path.join(__dirname, 'home.html');
let content = fs.readFileSync(filePath, 'utf8');

// Function to calculate fake price (25% higher than real price)
function getFakePrice(price) {
    return Math.round(price * 1.25);
}

// Update all fake prices in the players data
content = content.replace(
    /\{ name: '([^']+)', price: (\d+), fakePrice: (\d+),/g,
    (match, name, price) => {
        const fakePrice = getFakePrice(parseInt(price));
        return `{ name: '${name}', price: ${price}, fakePrice: ${fakePrice},`;
    }
);

// Update the probability of fake prices appearing to 70%
content = content.replace(
    /const displayPrice = Math\.random\(\) > 0\.5 \? player\.price : player\.fakePrice;/,
    'const displayPrice = Math.random() > 0.3 ? player.fakePrice : player.price;'
);

// Write the updated content back to the file
fs.writeFileSync(filePath, content, 'utf8');

console.log('✅ Fake prices updated to be 25% higher than real prices');
console.log('✅ Probability of fake prices set to 70%');
