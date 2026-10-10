/** Plain-language number formatting. ₹ for India, $ for US. */

export type CurrencyCode = "INR" | "USD"

export function currencyFor(country: string): CurrencyCode {
  return country === "IN" ? "INR" : "USD"
}

function trimmed(value: number, digits = 2): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: digits })
}

/** ₹1,234 crore / ₹12.5 lakh / $1.2 billion / $350 million */
export function formatMoney(value: number, currency: CurrencyCode): string {
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(value)
  if (currency === "INR") {
    if (abs >= 1e7) return `${sign}₹${trimmed(abs / 1e7)} crore`
    if (abs >= 1e5) return `${sign}₹${trimmed(abs / 1e5)} lakh`
    return `${sign}₹${trimmed(abs)}`
  }
  if (abs >= 1e9) return `${sign}$${trimmed(abs / 1e9)} billion`
  if (abs >= 1e6) return `${sign}$${trimmed(abs / 1e6)} million`
  return `${sign}$${trimmed(abs)}`
}

export function formatPerShare(value: number, currency: CurrencyCode): string {
  return `${currency === "INR" ? "₹" : "$"}${trimmed(value)} per share`
}

export function formatCount(value: number): string {
  return trimmed(value, 0)
}
