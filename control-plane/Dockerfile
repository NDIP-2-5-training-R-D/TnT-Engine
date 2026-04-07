FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3100
CMD ["node", "node_modules/next/dist/bin/next", "dev", "--port", "3100"]
