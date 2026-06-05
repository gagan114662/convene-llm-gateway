# Zero runtime deps: build with tsc, run plain node on the compiled output.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
ENV PORT=8095
EXPOSE 8095
CMD ["node", "dist/server.js"]
