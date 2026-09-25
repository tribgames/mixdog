// Crops a region of an image: node crop.mjs <in.png> <out.png> <left> <top> <width> <height>
import sharp from 'sharp';

const [input, output, left, top, width, height] = process.argv.slice(2);
await sharp(input).extract({ left: Number(left), top: Number(top), width: Number(width), height: Number(height) }).toFile(output);
