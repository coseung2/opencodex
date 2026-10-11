/** Decode only the terminal tool's leading answer string. Incomplete escapes wait
 * for the next chunk; full JSON validation remains owned by the Kiro parser. */
export class KiroAnswerStream {
  private prefix = "";
  private started = false;
  private stopped = false;
  private escape = "";
  private high = "";
  push(chunk: string): string {
    if (this.stopped) return "";
    let text = chunk;
    if (!this.started) {
      this.prefix += chunk;
      const match = /^\s*\{\s*"answer"\s*:\s*"/.exec(this.prefix);
      if (!match) { if (this.prefix.length > 256) this.stopped = true; return ""; }
      this.started = true; text = this.prefix.slice(match[0].length); this.prefix = "";
    }
    let output = "";
    const append = (char: string) => {
      if (this.high) { output += this.high; this.high = ""; }
      if (char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdbff) this.high = char;
      else output += char;
    };
    for (const char of text) {
      if (this.escape) {
        this.escape += char;
        if (this.escape === "\\u" || this.escape.startsWith("\\u") && this.escape.length < 6) continue;
        try { append(JSON.parse(`"${this.escape}"`) as string); }
        catch { this.stopped = true; return output; }
        this.escape = "";
      } else if (char === "\\") this.escape = "\\";
      else if (char === '"') { this.stopped = true; break; }
      else if (char.charCodeAt(0) < 0x20) { this.stopped = true; break; }
      else append(char);
    }
    return output;
  }
}
