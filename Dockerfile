FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p data
ENV PORT=4000 NODE_ENV=production
EXPOSE 4000
CMD ["node", "server.js"]
