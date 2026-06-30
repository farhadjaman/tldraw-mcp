FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

ENV MCP_TRANSPORT=http
ENV PORT=3002

EXPOSE 3002
CMD ["node", "dist/index.js"]
