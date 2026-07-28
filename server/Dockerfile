FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src
RUN npm install typescript tsx --no-save && npx tsc
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
