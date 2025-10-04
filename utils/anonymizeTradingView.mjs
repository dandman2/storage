// utils/anonymizeTradingView.mjs
import sharp from "sharp";
import Tesseract from "tesseract.js";

const DEBUG = true;
const OCR_TIMEOUT_MS = 15000;
const PROCESSABLE = /\.(png|jpe?g|webp)$/i;

function dlog(...args) {
  if (DEBUG) console.log("[anonymizer]", ...args);
}

async function detectCrop(buffer) {
  let heightToCrop = -1;
  try {
    const image = sharp(buffer);
    const { width, height } = await image.metadata();
    dlog(`Image dimensions: ${width}x${height}`);

    // Try different slice heights to find the header
    const sliceHeights = [
      Math.round(height * 0.04), // 4%
      Math.round(height * 0.05), // 5%
      Math.round(height * 0.06)  // 6%
    ];

    for (let i = 0; i < sliceHeights.length; i++) {
      const sliceHeight = sliceHeights[i];
      dlog(`\n=== Trying slice height: ${sliceHeight}px (${Math.round(sliceHeight/height*100)}%) ===`);
      
      // Try different preprocessing approaches
      const methods = [
        {
          name: "raw",
          process: async (img) => img.toBuffer()
        },
        {
          name: "upscale_only",
          process: async (img) => img.resize(width * 3, sliceHeight * 3, { kernel: 'cubic' }).toBuffer()
        },
        {
          name: "greyscale_upscale",
          process: async (img) => img.greyscale().resize(width * 3, sliceHeight * 3, { kernel: 'cubic' }).toBuffer()
        },
        {
          name: "normalize_upscale",
          process: async (img) => img.greyscale().normalize().resize(width * 3, sliceHeight * 3, { kernel: 'cubic' }).toBuffer()
        },
        {
          name: "sharpen_upscale",
          process: async (img) => img.greyscale().normalize().sharpen().resize(width * 3, sliceHeight * 3, { kernel: 'cubic' }).toBuffer()
        },
        {
          name: "gentle_threshold",
          process: async (img) => img.greyscale().normalize().threshold(100).resize(width * 3, sliceHeight * 3, { kernel: 'cubic' }).toBuffer()
        },
        {
          name: "contrast_boost",
          process: async (img) => img.greyscale().linear(2.0, -128).resize(width * 3, sliceHeight * 3, { kernel: 'cubic' }).toBuffer()
        }
      ];
      
      for (const method of methods) {
        try {
          console.log(`\n--- Testing method: ${method.name} ---`);
          
          const topSlice = await method.process(
            image.clone().extract({ left: 0, top: 0, width, height: sliceHeight })
          );
                  
          // Try OCR with whitelist for common TradingView text
          const ocrResult = await Promise.race([
            Tesseract.recognize(topSlice, "eng", {
              logger: (m) => {
                if (m.status === 'recognizing text') {
                  process.stdout.write(`\rOCR Progress: ${Math.round(m.progress * 100)}%`);
                }
              },
              tessedit_pageseg_mode: 6, // Single uniform block
              tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,:-+()% '
            }),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("OCR timeout")), OCR_TIMEOUT_MS)
            ),
          ]);
          
          console.log(`\nOCR Complete!`);
          
          const text = ocrResult.data.text.trim();
          const confidence = ocrResult.data.confidence;
          const words = ocrResult.data.words || [];
          
          console.log(`Text: "${text}"`);
          console.log(`Confidence: ${confidence.toFixed(1)}%`);
          console.log(`Words found: ${words.length}`);
          
          if (words.length > 0) {
            console.log(`First few words:`);
            words.slice(0, 5).forEach((word, i) => {
              console.log(`  ${i+1}: "${word.text}" (confidence: ${word.confidence.toFixed(1)})`);
            });
          }
          
          // Check for TradingView indicators (case insensitive)
          const textLower = text.toLowerCase();
          const indicators = [
            "created with tradingview",
            "tradingview.com",
            "tradingview",
            "created with",
            "נוצר עם tradingview.com",
            "נוצר עם tradingview",
            "נוצר עם",
          ];
          
          const found = indicators.find(indicator => textLower.includes(indicator));
          
          if (found) {
            console.log(`✅ FOUND indicator: "${found}"`);
            console.log(`Method that worked: ${method.name}`);
            heightToCrop = sliceHeight; // This is the height we want to crop from the top
          } else {
            console.log(`❌ No TradingView indicators found`);
            heightToCrop = 0; // No indicators found, so no crop needed
          }
        } catch (err) {
          console.log(`Method ${method.name} failed: ${err.message}`);
          // Try the next method
        }
      }

      if (heightToCrop === -1) {
        console.log(`\n❌ None of the methods successfully detected TradingView text`);
      }
      else {
        console.log(`✅ Detected TradingView header at height: ${heightToCrop}px`);
        break; // We found a valid crop height
      }
    }
  } catch (error) {
    console.error("[debug] Error processing image:", error);
    heightToCrop = -1;
  }

  return heightToCrop;
}

export async function anonymizeTradingViewIfNeeded(file) {
  try {
    if (!file.name || !PROCESSABLE.test(file.name)) return file;
    if (!Buffer.isBuffer(file.attachment)) return file;

    const cropTop = await detectCrop(file.attachment);
    if (!cropTop || cropTop == -1) return file;

    const image = sharp(file.attachment);
    const { width, height } = await image.metadata();
    const croppedBuffer = await image
      .extract({ left: 0, top: cropTop, width, height: height - cropTop })
      .toBuffer();

    dlog("cropped header:", { cropTop, newHeight: height - cropTop });
    return { ...file, attachment: croppedBuffer };
  } catch (err) {
    console.error("[anonymizer] processing failed, sending original:", err);
    return file;
  }
}