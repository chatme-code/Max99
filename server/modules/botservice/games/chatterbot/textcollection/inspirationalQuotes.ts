import { TextCollection } from "../textCollection";

export class InspirationalQuotes extends TextCollection {
  constructor() {
    super("inspirationalquotes", "Inspirational Quotes");
    this.loadTexts([
      "The only way to do great work is to love what you do. — Steve Jobs",
      "In the middle of every difficulty lies opportunity. — Albert Einstein",
      "Believe you can and you're halfway there. — Theodore Roosevelt",
      "It does not matter how slowly you go as long as you do not stop. — Confucius",
      "Everything you've ever wanted is on the other side of fear. — George Addair",
      "Success is not final, failure is not fatal: it is the courage to continue that counts. — Winston Churchill",
      "You miss 100% of the shots you don't take. — Wayne Gretzky",
      "I have not failed. I've just found 10,000 ways that won't work. — Thomas Edison",
      "Whether you think you can or you think you can't, you're right. — Henry Ford",
      "The best time to plant a tree was 20 years ago. The second best time is now. — Chinese Proverb",
      "An unexamined life is not worth living. — Socrates",
      "Spread love everywhere you go. — Mother Teresa",
      "When you reach the end of your rope, tie a knot in it and hang on. — Franklin D. Roosevelt",
      "Always remember that you are absolutely unique. — Margaret Mead",
      "Don't go through life, grow through life. — Eric Butterworth",
      "Build your own dreams, or someone else will hire you to build theirs. — Farrah Gray",
      "The most common way people give up their power is by thinking they don't have any. — Alice Walker",
      "Life is what happens to you while you're busy making other plans. — John Lennon",
      "You will face many defeats in life, but never let yourself be defeated. — Maya Angelou",
      "The greatest glory in living lies not in never falling, but in rising every time we fall. — Nelson Mandela",
    ]);
  }
}
