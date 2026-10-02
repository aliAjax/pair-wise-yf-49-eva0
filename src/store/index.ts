import { configureStore } from "@reduxjs/toolkit";
import courtReducer from "./courtSlice";
export const store = configureStore({ reducer: { court: courtReducer } });
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
