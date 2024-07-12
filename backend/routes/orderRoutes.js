import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import expressAsyncHandler from 'express-async-handler';
import Order from '../models/orderModel.js';
import User from '../models/userModel.js';
import Product from '../models/productModel.js';
import { isAuth, isAdmin, mailgun, payOrderEmailTemplate } from '../utils.js';

const orderRouter = express.Router();

orderRouter.post("/orders", async(req, res) => {
  try{
    const instance=new Razorpay({
      key_id: process.env.RAZOR_PAY_KEY_ID,
      key_secret: process.env.RAZOR_PAY_KEY_SECRET,
    });

    const options={
      amount: parseInt(req.body.amount*100),
      currency: "INR",
      receipt: crypto.randomBytes(10).toString("hex"),
    };
    instance.orders.create(options,(error,order)=>{
      if(error){
        console.log(error);
        return res.status(500).json({message:"Something went wrong!"});
      }
      res.status(200).json({data:order});
    })
  }catch(error){
    console.log('Error in creating the razorpay order', error);
    res.status(500).json({message:"Server error!"});
  }
});

orderRouter.post('/verify', async(req, res)=>{
  try{
    const{
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    }=req.body;
    const sign=razorpay_order_id+"|"+razorpay_payment_id;
    const expectedSign=crypto
    .createHmac("sha256",process.env.RAZOR_PAY_KEY_SECRET)
    .update(sign.toString())
    .digest("hex")
    if(razorpay_signature===expectedSign){
      return res.status(200).json(
        {
          success:true,
          order_id:razorpay_order_id,
        }
      );
    }else{
      console.log("Invalid signature");
      return res.status(400).json({message:"Invalid signature"});
    }
  }catch(error){
    console.log("Server error!");
    res.status(500).json({message:"Server error!"});
  }
});

orderRouter.get(
  '/',
  isAuth,
  isAdmin,
  expressAsyncHandler(async (req, res) => {
    const orders = await Order.find().populate('user', 'name');
    res.send(orders);
  })
);

orderRouter.post(
  '/',
  isAuth,
  expressAsyncHandler(async (req, res) => {
    const newOrder = new Order({
      orderItems: req.body.orderItems.map((x) => ({ ...x, product: x._id })),
      shippingAddress: req.body.shippingAddress,
      paymentMethod: req.body.paymentMethod,
      itemsPrice: req.body.itemsPrice,
      shippingPrice: req.body.shippingPrice,
      taxPrice: req.body.taxPrice,
      totalPrice: req.body.totalPrice,
      user: req.user._id,
      paidAt: Date.now(),
    });

    const order = await newOrder.save();
    
    // if (order) {
    //   mailgun()
    //     .messages()
    //     .send(
    //       {
    //         from: 'jithu.k.nmg@gmail.com',
    //         to: `${order.user.name} <${order.user.email}>`,
    //         subject: `New order ${order._id}`,
    //         html: payOrderEmailTemplate(order),
    //       },
    //       (error, body) => {
    //         if (error) {
    //           console.log(error);
    //         } else {
    //           console.log(body);
    //         }
    //       }
    //     );
    //   }
      res.status(201).send({ message: 'New Order Created', order });
  })
);

orderRouter.get(
  '/summary',
  isAuth,
  isAdmin,
  expressAsyncHandler(async (req, res) => {
    const orders = await Order.aggregate([
      {
        $group: {
          _id: null,
          numOrders: { $sum: 1 },
          totalSales: { $sum: '$totalPrice' },
        },
      },
    ]);
    const users = await User.aggregate([
      {
        $group: {
          _id: null,
          numUsers: { $sum: 1 },
        },
      },
    ]);
    const dailyOrders = await Order.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          orders: { $sum: 1 },
          sales: { $sum: '$totalPrice' },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const productCategories = await Product.aggregate([
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
        },
      },
    ]);
    res.send({ users, orders, dailyOrders, productCategories });
  })
);

orderRouter.get(
  '/mine',
  isAuth,
  expressAsyncHandler(async (req, res) => {
    const orders = await Order.find({ user: req.user._id });
    res.send(orders);
  })
);

orderRouter.get(
  '/:id',
  isAuth,
  expressAsyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (order) {
      res.send(order);
    } else {
      res.status(404).send({ message: 'Order Not Found' });
    }
  })
);

orderRouter.put(
  '/:id/deliver',
  isAuth,
  expressAsyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (order) {
      order.isDelivered = true;
      order.deliveredAt = Date.now();
      await order.save();
      res.send({ message: 'Order Delivered' });
    } else {
      res.status(404).send({ message: 'Order Not Found' });
    }
  })
);

orderRouter.put(
  '/:id/pay',
  isAuth,
  expressAsyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id).populate(
      'user',
      'email name'
    );
    
    if (order) {
      order.isPaid = true;
      order.paidAt = Date.now();
      // order.paymentResult = {
      //   id: req.body.id,
        // status: req.body.status,
        // update_time: req.body.update_time,
        // email_address: req.body.email_address,
      // };
      console.log(order);
      const updatedOrder = await order.save();
      mailgun()
        .messages()
        .send(
          {
            from: 'jithu.k.nmg@gmail.com',
            to: `${order.user.name} <${order.user.email}>`,
            subject: `New order ${order._id}`,
            html: payOrderEmailTemplate(order),
          },
          (error, body) => {
            if (error) {
              console.log(error);
            } else {
              console.log(body);
            }
          }
        );

      res.send({ message: 'Order Paid', order: updatedOrder });
    } else {
      res.status(404).send({ message: 'Order Not Found' });
    }
  })
);

orderRouter.delete(
  '/:id',
  isAuth,
  isAdmin,
  expressAsyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (order) {
      await order.remove();
      res.send({ message: 'Order Deleted' });
    } else {
      res.status(404).send({ message: 'Order Not Found' });
    }
  })
);

export default orderRouter;
