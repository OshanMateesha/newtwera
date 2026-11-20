# Playwright (WebKit ඇතුළුව browsers + system libs) කලින්ම තියෙන official image එක
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Dependencies කලින් install කරනවා (build cache වලට හොඳයි)
COPY package.json ./
RUN npm install --omit=dev

# ඉතුරු files copy කරනවා
COPY . .

ENV NODE_ENV=production
ENV PORT=7860

EXPOSE 7860

CMD ["node", "server.js"]
