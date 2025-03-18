import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import User from "@/models/User";
import Transaction from "@/models/Transaction";
import { sendEmail } from "@/lib/email";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";

export async function POST(req: Request) {
  const requestId = crypto.randomUUID();
  console.log(`[${requestId}] Transfer request received`);

  try {
    // Connect to the database with the improved connection method
    await dbConnect();
    console.log(`[${requestId}] MongoDB connection established`);

    // Get the authorization header
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.warn(
        `[${requestId}] Unauthorized request - missing or invalid authorization header`
      );
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify the token
    const token = authHeader.split(" ")[1];
    const payload = await verifyToken(token);
    if (!payload) {
      console.warn(`[${requestId}] Invalid token provided`);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    console.log(`[${requestId}] User authenticated: ${payload.sub}`);

    const { toUserId, amount } = await req.json();
    console.log(
      `[${requestId}] Transfer request: from=${payload.sub}, to=${toUserId}, amount=${amount}`
    );

    if (!toUserId || !amount || amount <= 0) {
      console.warn(
        `[${requestId}] Invalid transfer parameters: toUserId=${toUserId}, amount=${amount}`
      );
      return NextResponse.json(
        { error: "Invalid transfer parameters" },
        { status: 400 }
      );
    }

    // Start a session for the transaction
    const session = await mongoose.startSession();
    session.startTransaction();
    console.log(`[${requestId}] Transaction session started`);

    try {
      // Get both users
      const fromUser = await User.findById(payload.sub).session(session);
      const toUser = await User.findById(toUserId).session(session);

      if (!fromUser || !toUser) {
        console.warn(
          `[${requestId}] User not found: fromUser=${!!fromUser}, toUser=${!!toUser}`
        );
        await session.abortTransaction();
        console.log(`[${requestId}] Transaction aborted: User not found`);
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }

      console.log(
        `[${requestId}] Users found: from=${fromUser.name}, to=${toUser.name}`
      );

      // Calculate sender's balance from transaction history
      const userId = fromUser._id.toString();
      const transactions = await Transaction.find({})
        .populate("from", "name email")
        .populate("to", "name email")
        .sort({ date: -1 })
        .lean();

      console.log(
        `[${requestId}] Retrieved ${transactions.length} transactions for balance calculation`
      );

      let balance = 0;

      for (const transaction of transactions) {
        if (transaction.type === "onramp") {
          // User is receiving money from external source
          if (transaction.to._id.toString() === userId) {
            balance += transaction.amount;
          }
        } else if (transaction.type === "offramp") {
          // User is sending money to external source
          if (transaction.from._id.toString() === userId) {
            balance -= transaction.amount;
          }
        } else if (transaction.type === "transfer") {
          // Internal transfer between users
          if (transaction.to._id.toString() === userId) {
            // User received money
            balance += transaction.amount;
          }
          if (transaction.from._id.toString() === userId) {
            // User sent money
            balance -= transaction.amount;
          }
        }
      }

      console.log(`[${requestId}] Calculated balance for sender: ${balance}`);

      // Check if sender has enough balance
      if (balance < amount) {
        console.warn(
          `[${requestId}] Insufficient balance: available=${balance}, requested=${amount}`
        );
        await session.abortTransaction();
        console.log(`[${requestId}] Transaction aborted: Insufficient balance`);
        return NextResponse.json(
          { error: "Insufficient balance" },
          { status: 400 }
        );
      }

      // Create transaction record - we don't update user.balance anymore
      const transaction = new Transaction({
        type: "transfer",
        from: fromUser._id,
        to: toUser._id,
        amount: amount,
        date: new Date(),
      });

      await transaction.save({ session });
      console.log(
        `[${requestId}] Transaction record created: ${transaction._id}`
      );

      // Commit the transaction
      await session.commitTransaction();
      console.log(`[${requestId}] Database transaction committed successfully`);

      // End the session after committing
      session.endSession();
      console.log(`[${requestId}] Transaction session ended`);

      // Send email notification - moved outside the transaction try/catch block
      try {
        // Calculate receiver's new balance for the email
        const receiverTransactions = await Transaction.find({})
          .populate("from", "name email")
          .populate("to", "name email")
          .sort({ date: -1 })
          .lean();

        let receiverBalance = 0;
        const receiverId = toUser._id.toString();

        for (const tx of receiverTransactions) {
          if (tx.type === "onramp") {
            if (tx.to._id.toString() === receiverId) {
              receiverBalance += tx.amount;
            }
          } else if (tx.type === "offramp") {
            if (tx.from._id.toString() === receiverId) {
              receiverBalance -= tx.amount;
            }
          } else if (tx.type === "transfer") {
            if (tx.to._id.toString() === receiverId) {
              receiverBalance += tx.amount;
            }
            if (tx.from._id.toString() === receiverId) {
              receiverBalance -= tx.amount;
            }
          }
        }

        const emailContent = `
          Hello ${toUser.name},

          You have received a transfer of ${amount} from ${fromUser.name}.
          
          Your new balance is: ${receiverBalance}

          Best regards,
          FOCO.chat Team
        `;

        await sendEmail({
          to: toUser.email,
          subject: "Money Received on FOCO.chat",
          text: emailContent,
        });
        console.log(
          `[${requestId}] Notification email sent to ${toUser.email}`
        );
      } catch (emailError) {
        // Just log the email error but don't fail the whole transaction
        console.error(
          `[${requestId}] Error sending email notification:`,
          emailError
        );
        // The transaction is already committed, so we continue
      }

      console.log(`[${requestId}] Transfer completed successfully`);
      return NextResponse.json({
        message: "Transfer successful",
        transaction: transaction,
      });
    } catch (error) {
      // Only abort if the session is still active
      if (session.inTransaction()) {
        await session.abortTransaction();
        console.error(
          `[${requestId}] Transaction aborted due to error in processing`,
          error
        );
      }
      throw error;
    } finally {
      // Only end the session if it hasn't been ended already
      if (session) {
        session.endSession();
        console.log(`[${requestId}] Transaction session ended`);
      }
    }
  } catch (error) {
    console.error(`[${requestId}] Transfer error:`, error);
    return NextResponse.json(
      { error: "Failed to process transfer" },
      { status: 500 }
    );
  }
}
