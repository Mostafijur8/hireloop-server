import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import "dotenv/config";

const app = express();
const port = process.env.PORT || 5000;
const authBaseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000";
const allowedOrigin = process.env.CLIENT_URL || authBaseUrl;

app.use(express.json());
app.use(cors({ origin: allowedOrigin, credentials: true }));

const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}
const connectClient = await connectToMongoDB();
const database = connectClient.db("hireloopDB");
const users = database.collection("user");
const jobs = database.collection("jobs");

async function getRecruiter(req, res, next) {
  try {
    const sessionResponse = await fetch(
      `${authBaseUrl.replace(/\/$/, "")}/api/auth/get-session`,
      {
        headers: { cookie: req.headers.cookie || "" },
        cache: "no-store",
      },
    );

    if (!sessionResponse.ok) {
      return res.status(401).json({ error: "Please sign in to publish a job." });
    }

    const authData = await sessionResponse.json();
    if (!authData?.user) {
      return res.status(401).json({ error: "Please sign in to publish a job." });
    }
    if (authData.user.role !== "recruiter") {
      return res.status(403).json({ error: "Only recruiters can publish jobs." });
    }

    req.recruiter = authData.user;
    next();
  } catch (error) {
    next(error);
  }
}

function isJob(value) {
  return Boolean(
    value && typeof value === "object" &&
    typeof value.title === "string" && value.title.trim() &&
    typeof value.location === "string" && value.location.trim() &&
    typeof value.type === "string" && value.type.trim() &&
    typeof value.description === "string" && value.description.trim() &&
    value.salaryRange && typeof value.salaryRange === "object" &&
    typeof value.salaryRange.min === "string" &&
    typeof value.salaryRange.max === "string" &&
    value.salaryRange.currency === "BDT" &&
    value.salaryRange.period === "monthly"
  );
}

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/users", async (req, res) => {
  const cursor = users.find({});
  const result = await cursor.toArray();
  res.send(result);
});

app.post("/jobs", getRecruiter, async (req, res, next) => {
  if (!isJob(req.body)) {
    return res.status(400).json({ error: "Please provide valid job details." });
  }

  try {
    const job = {
      title: req.body.title.trim(),
      location: req.body.location.trim(),
      type: req.body.type.trim(),
      salaryRange: req.body.salaryRange,
      description: req.body.description.trim(),
      recruiterId: req.recruiter.id,
      status: "active",
      createdAt: new Date(),
    };
    const result = await jobs.insertOne(job);
    res.status(201).json({ id: result.insertedId.toString(), ...job });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error("API request failed:", error);
  res.status(500).json({ error: "The server could not complete the request." });
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
