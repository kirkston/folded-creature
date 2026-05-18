import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForTimeout(600);

const snap = async (label) =>
  page.evaluate((screen) => {
    const root = document.getElementById("root");
    const pageEl = document.querySelector("[data-layout-page]");
    const card = document.querySelector("[data-layout-card]");
    const cardStyle = card ? getComputedStyle(card) : null;
    const vw = window.innerWidth;
    return {
      screen,
      vw,
      docScrollW: document.documentElement.scrollWidth,
      overflowPx: document.documentElement.scrollWidth - vw,
      rootOffsetW: root?.offsetWidth,
      rootComputedW: root ? getComputedStyle(root).width : null,
      pageOffsetW: pageEl?.offsetWidth,
      cardOffsetW: card?.offsetWidth,
      cardComputedW: cardStyle?.width,
      cardMarginLR:
        card && cardStyle
          ? parseFloat(cardStyle.marginLeft) + parseFloat(cardStyle.marginRight)
          : null,
      cardRight: card ? Math.round(card.getBoundingClientRect().right) : null,
    };
  }, label);

const home = await snap("home");
await page.getByRole("button", { name: /Join a Friend/i }).click();
await page.waitForTimeout(600);
const join = await snap("join");

console.log(JSON.stringify({ home, join }, null, 2));
await browser.close();
